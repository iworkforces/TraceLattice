import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PersistenceConfig } from '../../contracts/PersistenceBackend.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import { createServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';
import { createTestSessionId, createTestThoughtId } from '../helpers/factories.js';

type Server = Awaited<ReturnType<typeof createServer>>;

const servers = new Set<Server>();

interface ProcessOptions {
	readonly subject: Server;
	readonly sessionId: string;
	readonly id: string;
	readonly thoughtNumber: number;
	readonly overrides?: Record<string, unknown>;
}

async function createPersistenceServer(persistence: PersistenceConfig): Promise<Server> {
	const subject = await createServer({
		autoDiscover: false,
		loadFromPersistence: false,
		config: new ServerConfig({
			maxHistorySize: 1,
			persistence,
			persistenceFlushInterval: 60_000,
		}),
	});
	servers.add(subject);
	return subject;
}

async function process(options: ProcessOptions) {
	return options.subject.processThought({
		id: options.id,
		thought: `${options.sessionId}-${options.thoughtNumber}`,
		thought_number: options.thoughtNumber,
		total_thoughts: options.thoughtNumber,
		next_thought_needed: false,
		session_id: options.sessionId,
		...options.overrides,
	});
}

async function evictOldestSession(subject: Server): Promise<void> {
	for (let index = 0; index < 99; index += 1) {
		await process({
			subject,
			sessionId: `retention-filler-${index}`,
			id: `filler-${index}`,
			thoughtNumber: 1,
		});
	}
	await subject.history._flushBuffer();
	await process({
		subject,
		sessionId: 'retention-eviction-trigger',
		id: 'trigger',
		thoughtNumber: 1,
	});
}

async function exerciseRestoredBranchPersistence(subject: Server, persistBranches: boolean) {
	// Given an evicted session whose durable history no longer contains the branch thought.
	const sessionId = 'disabled-branch-ownership';
	await process({
		subject,
		sessionId,
		id: 'branch-anchor',
		thoughtNumber: 1,
		overrides: { next_thought_needed: true },
	});
	await process({
		subject,
		sessionId,
		id: 'reusable-branch-id',
		thoughtNumber: 2,
		overrides: {
			branch_from_thought: 1,
			branch_id: 'retained-branch',
			next_thought_needed: true,
		},
	});
	await subject.history._flushBuffer();
	await process({ subject, sessionId, id: 'newer-history-id', thoughtNumber: 3 });
	await subject.history._flushBuffer();
	await evictOldestSession(subject);
	await subject.history._flushBuffer();
	const expired = await process({ subject, sessionId, id: 'reusable-branch-id', thoughtNumber: 4 });
	expect(expired.isError).toBe(true);
	expect(JSON.parse(expired.content[0]?.text ?? '{}')).toMatchObject({ code: 'SESSION_EXPIRED' });

	// Given startup restore against the still-owned backend, without resetting durable evidence.
	const restored = new HistoryManager({
		maxHistorySize: 1,
		persistence: subject.history.getPersistenceBackend(),
		persistenceHistorySize: 1,
		persistBranches,
		persistenceFlushInterval: 60_000,
	});
	try {
		await restored.loadFromPersistence();
		expect(restored.getHistory(sessionId).map((thought) => thought.id)).toEqual([
			'newer-history-id',
		]);
		expect(
			Object.values(restored.getBranches(sessionId)).flatMap((branch) =>
				branch.map((thought) => thought.id)
			)
		).toEqual(persistBranches ? ['reusable-branch-id'] : []);
		const processor = new ThoughtProcessor(
			restored,
			new ThoughtFormatter(),
			subject.getContainer().resolve('ThoughtEvaluator')
		);

		// When the same thought ID is submitted through ordinary identity admission after restore.
		return await processor.process({
			id: createTestThoughtId('reusable-branch-id'),
			thought: `${sessionId}-4`,
			thought_number: 4,
			total_thoughts: 4,
			next_thought_needed: false,
			session_id: createTestSessionId(sessionId),
		});
	} finally {
		await restored.shutdown();
	}
}

afterEach(async () => {
	for (const subject of servers) await subject.stop();
	servers.clear();
});

describe('public durable thought identity retention', () => {
	it.each([
		['memory', 0],
		['memory', -1],
		['file', 0],
		['file', -1],
		['sqlite', 0],
		['sqlite', -1],
	] as const)(
		'treats %s persistence maxHistorySize %i as unlimited',
		async (backend, maxHistorySize) => {
			const dataDir =
				backend === 'memory'
					? undefined
					: await mkdtemp(join(tmpdir(), `tracelattice-${backend}-unlimited-`));
			try {
				const options =
					backend === 'file'
						? { dataDir, maxHistorySize }
						: backend === 'sqlite'
							? { dbPath: join(dataDir ?? tmpdir(), 'history.db'), maxHistorySize }
							: { maxHistorySize };
				const subject = await createPersistenceServer({ enabled: true, backend, options });
				await process({
					subject,
					sessionId: 'unlimited-retention',
					id: 'retained-id',
					thoughtNumber: 1,
				});
				await subject.history._flushBuffer();
				await process({
					subject,
					sessionId: 'unlimited-retention',
					id: 'newer-id',
					thoughtNumber: 2,
				});
				await subject.history._flushBuffer();

				const duplicate = await process({
					subject,
					sessionId: 'unlimited-retention',
					id: 'retained-id',
					thoughtNumber: 3,
				});

				expect(duplicate.isError).toBe(true);
				expect(JSON.parse(duplicate.content[0]?.text ?? '{}')).toMatchObject({
					code: 'VALIDATION_ERROR',
				});
			} finally {
				for (const subject of servers) await subject.stop();
				servers.clear();
				if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
			}
		}
	);

	it('permits reuse after disabled Memory branch persistence leaves no durable copy', async () => {
		const subject = await createPersistenceServer({
			enabled: true,
			backend: 'memory',
			options: { maxHistorySize: 1, persistBranches: false },
		});

		const replacement = await exerciseRestoredBranchPersistence(subject, false);

		// Then no retained copy prevents admission.
		expect(replacement.isError).toBeUndefined();
	});

	it('permits reuse after disabled File branch persistence leaves no durable copy', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-disabled-branch-'));
		try {
			const subject = await createPersistenceServer({
				enabled: true,
				backend: 'file',
				options: { dataDir, maxHistorySize: 1, persistBranches: false },
			});

			const replacement = await exerciseRestoredBranchPersistence(subject, false);

			// Then no retained copy prevents admission.
			expect(replacement.isError).toBeUndefined();
		} finally {
			for (const subject of servers) await subject.stop();
			servers.clear();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it('rejects reuse while enabled branch persistence retains the id', async () => {
		const subject = await createPersistenceServer({
			enabled: true,
			backend: 'memory',
			options: { maxHistorySize: 1, persistBranches: true },
		});

		const duplicate = await exerciseRestoredBranchPersistence(subject, true);

		// Then the retained branch identity rejects admission, rather than session expiry.
		expect(duplicate.isError).toBe(true);
		expect(JSON.parse(duplicate.content[0]?.text ?? '{}')).toMatchObject({
			code: 'VALIDATION_ERROR',
		});
	});
});
