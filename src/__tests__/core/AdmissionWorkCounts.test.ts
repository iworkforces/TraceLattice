import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asSessionId, asThoughtId } from '../../contracts/ids.js';
import * as VerificationLinks from '../../core/evaluator/VerificationLinks.js';
import type { ThoughtData } from '../../core/thought.js';
import { createServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';
import { createTestThought } from '../helpers/factories.js';

vi.mock('../../core/evaluator/VerificationLinks.js', async (importOriginal) => {
	const actual = await importOriginal<typeof VerificationLinks>();
	return { ...actual, resolveVerificationLinks: vi.fn(actual.resolveVerificationLinks) };
});

type Server = Awaited<ReturnType<typeof createServer>>;
type PublicInput = Parameters<Server['processThought']>[0];

interface AdmissionWork {
	readonly snapshotCopies: number;
	readonly linkResolutions: number;
	readonly clonedThoughts: readonly ThoughtData[];
	readonly activeCount: number;
}

const SESSION = asSessionId('admission-work');
const SESSION_SIZES = [10, 50, 200] as const;
const servers = new Set<Server>();

/** Cycle of six thought shapes: main, hypothesis, explicit verifier, branch, branch hypothesis, legacy verifier. */
function scriptedThought(index: number): PublicInput {
	const base = {
		id: `t${index}`,
		session_id: SESSION,
		thought: `t${index}`,
		thought_number: index,
		total_thoughts: 400,
		next_thought_needed: true,
	};
	const branch = { branch_id: `b${Math.floor(index / 12)}`, branch_from_thought: index - 1 };
	switch (index % 6) {
		case 2:
			return { ...base, thought_type: 'hypothesis', hypothesis_id: `H${index}`, confidence: 0.6 };
		case 3:
			return {
				...base,
				thought_type: 'verification',
				verification_target: index - 1,
				verification_result: 1,
				confidence: 0.8,
			};
		case 4:
			return { ...base, ...branch };
		case 5:
			return {
				...base,
				...branch,
				thought_type: 'hypothesis',
				hypothesis_id: `H${index}`,
				confidence: 0.5,
			};
		case 0:
			return { ...base, thought_type: 'verification', hypothesis_id: `H${index - 1}` };
		default:
			return base;
	}
}

function isSessionThought(value: unknown): value is ThoughtData {
	return (
		typeof value === 'object' &&
		value !== null &&
		'session_id' in value &&
		value.session_id === SESSION
	);
}

function activeThoughtCount(server: Server): number {
	const retained = [
		...server.history.getHistory(SESSION),
		...Object.values(server.history.getBranches(SESSION)).flat(),
	];
	return new Set(retained.filter((thought) => thought.retracted !== true).map((t) => t.id)).size;
}

async function createMeasuredServer(maxHistorySize: number): Promise<Server> {
	const server = await createServer({
		autoDiscover: false,
		loadFromPersistence: false,
		config: new ServerConfig({ maxHistorySize }),
	});
	servers.add(server);
	return server;
}

async function admitSession(size: number): Promise<{ server: Server; works: AdmissionWork[] }> {
	// A small history window pushes early branch thoughts out of main history, so branch-only
	// thoughts stay in the active set.
	const server = await createMeasuredServer(Math.max(4, Math.floor(size / 2)));
	expect(server.getContainer().resolve('Persistence')).toBeNull();
	const inspectSession = vi.spyOn(server.history, 'inspectSession');
	const structuredCloneSpy = vi.spyOn(globalThis, 'structuredClone');
	const resolveLinks = vi.mocked(VerificationLinks.resolveVerificationLinks);
	const works: AdmissionWork[] = [];
	for (let index = 1; index <= size; index++) {
		inspectSession.mockClear();
		structuredCloneSpy.mockClear();
		resolveLinks.mockClear();
		const result = await server.processThought(scriptedThought(index));
		expect(result.isError).not.toBe(true);
		works.push({
			snapshotCopies: inspectSession.mock.calls.length,
			linkResolutions: resolveLinks.mock.calls.length,
			clonedThoughts: structuredCloneSpy.mock.calls
				.map(([value]) => value)
				.filter(isSessionThought),
			activeCount: activeThoughtCount(server),
		});
	}
	return { server, works };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const server of servers) await server.dispose();
	servers.clear();
	vi.useRealTimers();
});

describe('work per admitted thought', () => {
	it.each(SESSION_SIZES)(
		'copies the snapshot and resolves links once per admission in a %i-thought session',
		async (size) => {
			const { works } = await admitSession(size);

			expect.soft(works.map((work) => work.snapshotCopies)).toEqual(Array(size).fill(1));
			expect.soft(works.map((work) => work.linkResolutions)).toEqual(Array(size).fill(1));
		}
	);

	it.each(SESSION_SIZES)(
		'clones each active thought exactly once in a %i-thought session',
		async (size) => {
			const { server, works } = await admitSession(size);
			const last = works.at(-1);

			expect(works.map((work) => work.clonedThoughts.length)).toEqual(
				works.map((work) => work.activeCount)
			);
			expect(
				works.every((work) => new Set(work.clonedThoughts).size === work.clonedThoughts.length)
			).toBe(true);
			// The session must really contain branch-only evidence beyond main history.
			expect(last?.activeCount).toBeGreaterThan(server.history.getHistoryLength(SESSION));
		}
	);
});

describe('explicit verification target resolution', () => {
	function resolveWithTrackedHypotheses(size: number) {
		const reads = { count: 0 };
		const hypotheses = Array.from({ length: size }, (_, index) => {
			const hypothesis = createTestThought({
				thought_number: index + 1,
				thought_type: 'hypothesis',
			});
			return Object.defineProperty(hypothesis, 'id', {
				enumerable: true,
				get: () => {
					reads.count++;
					return asThoughtId(`h${index}`);
				},
			});
		});
		const verifiers = Array.from({ length: size }, (_, index) =>
			createTestThought({
				id: `v${index}`,
				thought_number: size + index + 1,
				thought_type: 'verification',
				verification_target: index + 1,
			})
		);
		const admissionTargets = new Map(
			verifiers.map((_, index) => [asThoughtId(`v${index}`), asThoughtId(`h${index}`)])
		);
		const links = VerificationLinks.resolveVerificationLinks(
			[...hypotheses, ...verifiers],
			{},
			admissionTargets
		);
		return { links, readsPerHypothesis: reads.count / size };
	}

	it('reads each hypothesis a constant number of times however many verifiers target it', () => {
		const resolved = SESSION_SIZES.map((size) => resolveWithTrackedHypotheses(size));

		expect(resolved.map(({ links }) => links.verifiedHypothesisCount)).toEqual([...SESSION_SIZES]);
		expect(new Set(resolved.map(({ readsPerHypothesis }) => readsPerHypothesis)).size).toBe(1);
	});
});
