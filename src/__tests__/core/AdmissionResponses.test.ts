import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureFlags } from '../../contracts/features.js';
import { asSessionId } from '../../contracts/ids.js';
import { createServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';

type Server = Awaited<ReturnType<typeof createServer>>;
type PublicInput = Parameters<Server['processThought']>[0];
type Strategy = FeatureFlags['reasoningStrategy'];
type PinnedResponses = Readonly<Record<Strategy, readonly unknown[]>>;

const SESSION = asSessionId('admission-pin');
const FIXTURE = new URL('./fixtures/admission-responses.json', import.meta.url);
const BASE_FEATURES: FeatureFlags = {
	dagEdges: true,
	reasoningStrategy: 'sequential',
	calibration: true,
	compression: true,
	toolInterleave: true,
	newThoughtTypes: true,
	outcomeRecording: true,
};
const servers = new Set<Server>();

function step(
	thoughtNumber: number,
	id: string,
	overrides: Partial<PublicInput> = {}
): PublicInput {
	return {
		id,
		session_id: SESSION,
		thought: id,
		thought_number: thoughtNumber,
		total_thoughts: 20,
		next_thought_needed: true,
		...overrides,
	};
}

/**
 * History is capped at 6, so the early branch thoughts leave main history while their branch
 * copies stay retained. Two branches interleave so branch-only order differs from thought order.
 */
const SCRIPT: readonly PublicInput[] = [
	step(1, 'm1'),
	step(2, 'hyp-a', { thought_type: 'hypothesis', hypothesis_id: 'H-A', confidence: 0.6 }),
	step(3, 'hyp-b', { thought_type: 'hypothesis', hypothesis_id: 'H-B', confidence: 0.5 }),
	step(4, 'ver-explicit', {
		thought_type: 'verification',
		verification_target: 2,
		verification_result: 1,
		confidence: 0.9,
	}),
	step(5, 'ver-legacy', { thought_type: 'verification', hypothesis_id: 'H-B', confidence: 0.8 }),
	step(6, 'alt-1', { branch_id: 'alt', branch_from_thought: 3 }),
	step(7, 'alt-hyp', {
		thought_type: 'hypothesis',
		hypothesis_id: 'H-C',
		branch_id: 'alt',
		branch_from_thought: 3,
		confidence: 0.7,
	}),
	step(8, 'alt-ver', {
		thought_type: 'verification',
		verification_target: 7,
		verification_result: 0,
		confidence: 0.4,
		branch_id: 'alt',
		branch_from_thought: 3,
	}),
	step(9, 'beta-1', { branch_id: 'beta', branch_from_thought: 8 }),
	step(10, 'alt-2', { branch_id: 'alt', branch_from_thought: 8 }),
	step(11, 'crit', { thought_type: 'critique', verification_target: 8 }),
	step(12, 'm12'),
	step(13, 'm13'),
	step(14, 'bt', { thought_type: 'backtrack', backtrack_target: 7 }),
	step(15, 'syn', { thought_type: 'synthesis', synthesis_sources: [8, 10] }),
	step(16, 'ver-late', { thought_type: 'verification', verification_target: 7 }),
];

async function pinnedResponses(): Promise<PinnedResponses> {
	const parsed: PinnedResponses = JSON.parse(await readFile(FIXTURE, 'utf8'));
	return parsed;
}

async function runScript(strategy: Strategy): Promise<{ server: Server; texts: string[] }> {
	const server = await createServer({
		autoDiscover: false,
		loadFromPersistence: false,
		config: new ServerConfig({
			maxHistorySize: 6,
			features: { ...BASE_FEATURES, reasoningStrategy: strategy },
		}),
	});
	servers.add(server);
	const texts: string[] = [];
	for (const input of SCRIPT) {
		const result = await server.processThought(input);
		expect(result.isError).not.toBe(true);
		texts.push(result.content[0]?.text ?? '');
	}
	return { server, texts };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(async () => {
	for (const server of servers) await server.dispose();
	servers.clear();
	vi.useRealTimers();
});

describe('admission responses stay byte-identical', () => {
	it.each<Strategy>(['sequential', 'tot'])(
		'pins every %s response of a mixed session',
		async (strategy) => {
			const { texts } = await runScript(strategy);
			const expected = (await pinnedResponses())[strategy];

			expect(texts).toHaveLength(SCRIPT.length);
			expect(texts).toEqual(expected.map((response) => JSON.stringify(response, null, 2)));
		}
	);

	it('exercises branch-only and retracted evidence in the pinned session', async () => {
		const { server } = await runScript('sequential');
		const historyIds = new Set(server.history.getHistory(SESSION).map((thought) => thought.id));
		const branchOnly = Object.values(server.history.getBranches(SESSION))
			.flat()
			.filter((thought) => !historyIds.has(thought.id));

		expect(branchOnly.map((thought) => thought.id)).toEqual([
			'alt-1',
			'alt-hyp',
			'alt-ver',
			'alt-2',
			'beta-1',
		]);
		expect(branchOnly.find((thought) => thought.id === 'alt-hyp')?.retracted).toBe(true);
	});
});
