import { expect } from 'vitest';
import { asBranchId, asSessionId, asSummaryId, asThoughtId } from '../../contracts/ids.js';
import { runWithContext } from '../../context/RequestContext.js';
import type { Summary } from '../../core/compression/Summary.js';
import { createServer, type ToolAwareSequentialThinkingServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';
import type { DurableBackend } from './ReliabilityPersistenceScenarios.js';
import { createReliabilityRoot, runReliabilityFixture } from './ReliabilityScenarioHarness.js';

type ScenarioBackend = 'memory' | DurableBackend;

async function configuredServer(
	backend: ScenarioBackend,
	root: string,
	bounded = false
): Promise<ToolAwareSequentialThinkingServer> {
	const options =
		backend === 'file'
			? { dataDir: root, persistBranches: true }
			: backend === 'sqlite'
				? { dbPath: `${root}/history.db` }
				: { persistBranches: true };
	return createServer({
		config: new ServerConfig({
			maxHistorySize: bounded ? 2 : 20,
			maxBranches: bounded ? 2 : 10,
			maxBranchSize: bounded ? 1 : 10,
			maxSessionsPerOwner: bounded ? 2 : 10,
			persistence: { enabled: true, backend, options },
			persistenceBufferSize: 100,
			persistenceFlushInterval: 60_000,
			persistenceMaxRetries: 0,
		}),
		autoDiscover: false,
		loadFromPersistence: false,
	});
}

function thought(sessionId: string, number: number, text = `${sessionId}-${number}`) {
	return {
		thought: text,
		thought_number: number,
		total_thoughts: 20,
		next_thought_needed: false,
		session_id: sessionId,
	};
}

export async function assertMalformedIdentityRejected(): Promise<void> {
	for (const backend of ['memory', 'file', 'sqlite'] as const) {
		const root = await createReliabilityRoot(`tracelattice-reliability-${backend}-identity-`);
		const server = await configuredServer(backend, root);
		try {
			await server.processThought(thought('B', 1, 'B exact'));
			await server.history._flushBuffer();
			const candidate = {
				...thought('bad/session', 1, 'must fail'),
				reset_state: true,
				register_branch_id: 'must-not-register',
				tool_arguments: { nested: ['unchanged'] },
			};
			const before = structuredClone(candidate);
			const result = await server.processThought(candidate);
			expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
				code: 'VALIDATION_ERROR',
			});
			expect(candidate).toEqual(before);
			expect(server.history.getSessionIds()).toEqual([asSessionId('B')]);
			expect(server.history.branchExists('B', asBranchId('must-not-register'))).toBe(false);
			const persistence = server.getContainer().resolve('Persistence');
			expect(persistence).not.toBeNull();
			if (persistence) expect(await persistence.listSessions()).toEqual([asSessionId('B')]);
		} finally {
			await server.dispose();
		}
	}
}

function summary(sessionId: string, cycle: number): Summary {
	return {
		id: asSummaryId(`summary-${cycle}`),
		sessionId: asSessionId(sessionId),
		rootThoughtId: asThoughtId(`${sessionId}-root`),
		coveredIds: [asThoughtId(`${sessionId}-root`)],
		coveredRange: [1, 1],
		topics: ['churn'],
		aggregateConfidence: 0.8,
		createdAt: cycle,
	};
}

function hintSessions(server: ToolAwareSequentialThinkingServer): Map<unknown, unknown> {
	const processor = server.getContainer().resolve('ThoughtProcessor');
	const cooldowns = Reflect.get(processor, '_hintCooldowns');
	if (!(cooldowns instanceof Map)) throw new TypeError('Hint cooldown map is unavailable');
	return cooldowns;
}

export async function assertFiveCycleBoundedChurn(backend: ScenarioBackend): Promise<void> {
	const root = await createReliabilityRoot(`tracelattice-reliability-${backend}-churn-`);
	const server = await configuredServer(backend, root, true);
	try {
		for (let cycle = 0; cycle < 5; cycle += 1) {
			const sessionId = `cycle-${cycle}`;
			for (let number = 1; number <= 3; number += 1) {
				await server.processThought({
					...thought(sessionId, number),
					...(number > 1 ? { branch_from_thought: number - 1, branch_id: `branch-${number}` } : {}),
				});
			}
			const session = asSessionId(sessionId);
			const container = server.getContainer();
			container.resolve('summaryStore').add(summary(sessionId, cycle));
			container.resolve('suspensionStore').suspend({
				sessionId: session,
				toolCallThoughtNumber: 3,
				toolCallThoughtId: asThoughtId(`${sessionId}-call`),
				toolName: 'tool',
				toolArguments: {},
				expiresAt: Number.MAX_SAFE_INTEGER,
			});
			container.resolve('outcomeRecorder').recordVerification({
				thoughtId: asThoughtId(`${sessionId}-outcome`),
				sessionId: session,
				predicted: 0.8,
				actual: 1,
				type: 'verification',
			});
			container.resolve('calibrator').refit(session);
			expect(server.history.getHistory(session)).toHaveLength(2);
			expect(server.history.getBranchIds(session)).toHaveLength(2);
			expect(server.history.getBranch(asBranchId('branch-3'), session)).toHaveLength(1);
			const retainedIds = new Set([
				...server.history.getHistory(session).map(({ id }) => id),
				...Object.values(server.history.getBranches(session)).flatMap((branch) =>
					branch.map(({ id }) => id)
				),
			]);
			const edges = container.resolve('EdgeStore').edgesForSession(session);
			expect(edges.length).toBeLessThanOrEqual(2);
			for (const edge of edges) {
				expect(retainedIds.has(edge.from)).toBe(true);
				expect(retainedIds.has(edge.to)).toBe(true);
			}
			hintSessions(server).set(sessionId, new Map([['probe', cycle]]));
			expect(server.history.getWriteBufferLength()).toBeGreaterThan(0);
			await server.resetSession(session);
			expect(server.history.resolveThoughtReference(session, 3)).toEqual({ kind: 'missing' });
			expect(container.resolve('EdgeStore').size(session)).toBe(0);
			expect(container.resolve('summaryStore').size(session)).toBe(0);
			expect(container.resolve('suspensionStore').size(session)).toBe(0);
			expect(container.resolve('outcomeRecorder').getAllOutcomes()).toEqual([]);
			expect(container.resolve('calibrator').metrics(session).sampleCount).toBe(0);
			expect(hintSessions(server).has(sessionId)).toBe(false);
			expect(server.history.getWriteBufferLength()).toBe(0);
		}
		let finalAdmission:
			Awaited<ReturnType<ToolAwareSequentialThinkingServer['processThought']>> | undefined;
		for (const sessionId of ['owner-a', 'owner-b', 'owner-c']) {
			finalAdmission = await runWithContext({ requestId: sessionId, owner: 'bounded-owner' }, () =>
				server.processThought(thought(sessionId, 1))
			);
		}
		expect(server.history.getSessionIds().filter((id) => id.startsWith('owner-'))).toEqual([
			asSessionId('owner-a'),
			asSessionId('owner-b'),
		]);
		expect(JSON.parse(finalAdmission?.content[0]?.text ?? '{}')).toMatchObject({
			code: 'MAX_SESSIONS_REACHED',
		});
		await server.resetAll();
		expect(server.history.getSessionIds()).toEqual([]);
		expect(server.history.getWriteBufferLength()).toBe(0);
		await server.stop();
		if (backend === 'memory') {
			const restarted = await configuredServer('memory', root, true);
			try {
				expect(restarted.history.getSessionIds()).toEqual([]);
				expect(restarted.history.getWriteBufferLength()).toBe(0);
			} finally {
				await restarted.dispose();
			}
		} else {
			expect(await runReliabilityFixture('inspect', { backend, root })).toMatchObject({
				sessionIds: [],
				state: { A: [], B: [] },
				pendingWrites: 0,
			});
		}
	} finally {
		await server.dispose();
	}
}
