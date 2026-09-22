import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PersistenceConfig } from '../../contracts/PersistenceBackend.js';
import { createServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';

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

async function exerciseDisabledBranchPersistence(subject: Server) {
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
	return process({ subject, sessionId, id: 'reusable-branch-id', thoughtNumber: 4 });
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

		const replacement = await exerciseDisabledBranchPersistence(subject);

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

			const replacement = await exerciseDisabledBranchPersistence(subject);

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

		const duplicate = await exerciseDisabledBranchPersistence(subject);

		expect(duplicate.isError).toBe(true);
		expect(JSON.parse(duplicate.content[0]?.text ?? '{}')).toMatchObject({
			code: 'VALIDATION_ERROR',
		});
	});
});
