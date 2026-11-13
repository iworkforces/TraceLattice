import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { expect } from 'vitest';
import {
	createReliabilityRoot,
	runReliabilityFixture,
	spawnReliabilityFixture,
	withDeadline,
} from './ReliabilityScenarioHarness.js';

export type DurableBackend = 'file' | 'sqlite';

const EXACT_STATE = {
	A: [{ thought: 'A exact', number: 1 }],
	B: [{ thought: 'B exact', number: 1 }],
} as const;

function fixtureConfiguration(
	backend: DurableBackend,
	root: string
): Readonly<Record<string, string>> {
	return { backend, root };
}

export async function assertIsolationRestartReset(backend: DurableBackend): Promise<void> {
	const root = await createReliabilityRoot(`tracelattice-reliability-${backend}-isolation-`);
	const configuration = fixtureConfiguration(backend, root);
	const seeded = await runReliabilityFixture('seed', configuration);
	expect(seeded).toMatchObject({
		event: 'scenario-final',
		before: EXACT_STATE,
		afterDenied: EXACT_STATE,
		denied: 'SESSION_ACCESS_DENIED',
		unhandledRejections: [],
		uncaughtExceptions: [],
	});
	const firstRestart = await runReliabilityFixture('inspect', configuration);
	expect(firstRestart).toMatchObject({ state: EXACT_STATE, pendingWrites: 0 });
	const reset = await runReliabilityFixture('reset', configuration);
	expect(reset).toMatchObject({
		beforeB: EXACT_STATE.B,
		state: { A: [], B: EXACT_STATE.B },
		pendingWrites: 0,
	});
	const secondRestart = await runReliabilityFixture('inspect', configuration);
	expect(secondRestart).toMatchObject({
		state: { A: [], B: EXACT_STATE.B },
		pendingWrites: 0,
		unhandledRejections: [],
		uncaughtExceptions: [],
	});
}

export async function assertRetainedReferenceRestart(backend: DurableBackend): Promise<void> {
	const root = await createReliabilityRoot(`tracelattice-reliability-${backend}-reference-`);
	const configuration = fixtureConfiguration(backend, root);
	expect(await runReliabilityFixture('reference-seed', configuration)).toMatchObject({
		seeded: true,
	});
	const used = await runReliabilityFixture('reference-use', configuration);
	expect(used['isError']).not.toBe(true);
	expect(used).toMatchObject({
		resolvedBefore: { kind: 'unique' },
		relation: { kind: 'verifies', sessionId: 'A', to: 'A-retained-seven' },
		state: { A: [], B: [{ thought: 'B same seven', number: 7 }] },
	});
	expect('warning' in used).toBe(false);
	const restarted = await runReliabilityFixture('inspect', configuration);
	expect(restarted).toMatchObject({
		state: { A: [], B: [{ thought: 'B same seven', number: 7 }] },
		references: { A: { kind: 'missing' }, B: { kind: 'unique' } },
		pendingWrites: 0,
	});
}

export async function assertSqliteAbruptDrain(): Promise<void> {
	const root = await createReliabilityRoot('tracelattice-reliability-sqlite-abrupt-');
	const configuration = fixtureConfiguration('sqlite', root);
	const fixture = spawnReliabilityFixture('abrupt-sqlite', configuration);
	expect(await fixture.nextEvent()).toEqual({ event: 'scenario-ready' });
	expect(await fixture.nextEvent()).toEqual({ event: 'acknowledged', pendingWrites: 0 });
	expect(fixture.child.kill('SIGKILL')).toBe(true);
	expect(await withDeadline(fixture.exited, 5_000, 'abrupt SQLite child close')).toEqual({
		code: null,
		signal: 'SIGKILL',
	});
	const restarted = await runReliabilityFixture('inspect', configuration);
	expect(restarted).toMatchObject({
		state: {
			A: [{ thought: 'A acknowledged', number: 1 }],
			B: [{ thought: 'B acknowledged', number: 1 }],
		},
		pendingWrites: 0,
	});
	const inspection = new Database(join(root, 'history.db'), {
		readonly: true,
		fileMustExist: true,
	});
	try {
		expect(inspection.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
	} finally {
		inspection.close();
	}
}

async function killedFileWriterArtifacts(root: string): Promise<readonly string[]> {
	const entries = await readdir(root);
	return entries
		.filter((entry) => entry === '.tracelattice-writer.lock' || entry.endsWith('.tmp'))
		.sort();
}

export async function assertFilePublicationInterruption(): Promise<void> {
	for (const phase of ['before', 'after'] as const) {
		const root = await createReliabilityRoot(`tracelattice-reliability-file-${phase}-`);
		const configuration = fixtureConfiguration('file', root);
		await runReliabilityFixture('seed', configuration);
		const fixture = spawnReliabilityFixture('file-interruption', { ...configuration, phase });
		expect(await fixture.nextEvent()).toEqual({ event: 'scenario-ready' });
		const blocked = await fixture.nextEvent();
		expect(blocked).toMatchObject({
			event: 'publication-blocked',
			phase,
			source: expect.stringMatching(/\.tmp$/),
		});
		expect(basename(String(blocked['destination']))).toBe('snapshot.json');
		expect(fixture.child.kill('SIGKILL')).toBe(true);
		expect(await withDeadline(fixture.exited, 5_000, `file ${phase} child close`)).toEqual({
			code: null,
			signal: 'SIGKILL',
		});
		const artifacts = await killedFileWriterArtifacts(root);
		expect(artifacts).toContain('.tracelattice-writer.lock');
		if (phase === 'before') expect(artifacts.some((entry) => entry.endsWith('.tmp'))).toBe(true);
		if (phase === 'after') expect(artifacts.some((entry) => entry.endsWith('.tmp'))).toBe(false);
		const restarted = await runReliabilityFixture('inspect', configuration);
		const expectedA =
			phase === 'before'
				? [{ thought: 'A exact', number: 1 }]
				: [
						{ thought: 'A exact', number: 1 },
						{ thought: 'A after candidate', number: 2 },
					];
		expect(restarted).toMatchObject({
			state: { A: expectedA, B: EXACT_STATE.B },
			pendingWrites: 0,
			unhandledRejections: [],
			uncaughtExceptions: [],
		});
		expect(await killedFileWriterArtifacts(root)).toEqual([]);
	}
}
