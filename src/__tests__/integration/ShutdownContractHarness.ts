import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export class ShutdownContractFixtureError extends Error {
	override readonly name = 'ShutdownContractFixtureError';
}

export type ProcessExit = {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
};

type CapturedChild = ChildProcessByStdio<Writable, Readable, Readable>;

export type RunningProcess = {
	readonly child: CapturedChild;
	readonly exited: Promise<ProcessExit>;
	readonly stdout: () => string;
	readonly stderr: () => string;
	waitForStderr(marker: string): Promise<void>;
};

export type FixtureMode = 'deadline' | 'cleanup-rejection' | 'streamable-file' | 'reload-file';

export type FixtureEvent = Readonly<{ event: string } & Record<string, unknown>>;

export type RunningFixture = RunningProcess & {
	nextEvent(): Promise<FixtureEvent>;
	send(control: string, data?: Readonly<Record<string, unknown>>): Promise<void>;
};

export type WireResponse = { readonly status: number; readonly body: string };

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const builtCli = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));
const fixtureScript = fileURLToPath(new URL('./shutdown-contract.fixture.mjs', import.meta.url));
const runningChildren = new Set<RunningProcess>();
const temporaryDirectories = new Set<string>();

export function withDeadline<T>(
	promise: Promise<T>,
	timeoutMs: number,
	operation: string
): Promise<T> {
	let timeout: NodeJS.Timeout | null = null;
	const deadline = new Promise<T>((_resolve, reject) => {
		timeout = setTimeout(
			() => reject(new ShutdownContractFixtureError(`${operation} timed out after ${timeoutMs}ms`)),
			timeoutMs
		);
	});
	return Promise.race([promise, deadline]).finally(() => {
		if (timeout) clearTimeout(timeout);
	});
}

function hasCapturedStreams(child: ChildProcess): child is CapturedChild {
	return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

function captureChild(child: ChildProcess): RunningProcess {
	if (!hasCapturedStreams(child)) {
		throw new ShutdownContractFixtureError('Subprocess stdio pipes are unavailable');
	}
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
	child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
	const exited = new Promise<ProcessExit>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code, signal) => resolve({ code, signal }));
	});
	const running: RunningProcess = {
		child,
		exited,
		stdout: () => stdout,
		stderr: () => stderr,
		waitForStderr: async (marker) => {
			if (stderr.includes(marker)) return;
			await new Promise<void>((resolve, reject) => {
				const cleanup = (): void => {
					child.stderr.off('data', onData);
					child.off('close', onClose);
				};
				const onData = (): void => {
					if (!stderr.includes(marker)) return;
					cleanup();
					resolve();
				};
				const onClose = (): void => {
					cleanup();
					reject(
						new ShutdownContractFixtureError(
							`Process exited before emitting ${JSON.stringify(marker)}: ${stderr}`
						)
					);
				};
				child.stderr.on('data', onData);
				child.once('close', onClose);
			});
		},
	};
	runningChildren.add(running);
	void exited.finally(() => runningChildren.delete(running));
	return running;
}

export function spawnCli(environment: NodeJS.ProcessEnv): RunningProcess {
	return captureChild(
		spawn(process.execPath, [builtCli], {
			cwd: repositoryRoot,
			env: { ...process.env, TRACELATTICE_PRETTY_LOG: 'false', ...environment },
			stdio: ['pipe', 'pipe', 'pipe'] as const,
		})
	);
}

export function spawnFixture(mode: FixtureMode): RunningFixture {
	const child = spawn(process.execPath, ['--unhandled-rejections=strict', fixtureScript, mode], {
		cwd: repositoryRoot,
		env: { ...process.env, TRACELATTICE_PRETTY_LOG: 'false' },
		stdio: ['pipe', 'pipe', 'pipe', 'ipc'] as const,
	});
	const running = captureChild(child);
	const messages: FixtureEvent[] = [];
	const waiters: PromiseWithResolvers<FixtureEvent>[] = [];
	child.on('message', (message: unknown) => {
		if (typeof message !== 'object' || message === null || !('event' in message)) return;
		const event = Reflect.get(message, 'event');
		if (typeof event !== 'string') return;
		const parsed = Object.freeze({ ...message, event });
		const waiter = waiters.shift();
		if (waiter) waiter.resolve(parsed);
		else messages.push(parsed);
	});
	return {
		...running,
		nextEvent: async () => {
			const queued = messages.shift();
			if (queued) return queued;
			const waiter = Promise.withResolvers<FixtureEvent>();
			waiters.push(waiter);
			return withDeadline(waiter.promise, 5_000, `${mode} fixture event`);
		},
		send: async (control, data = {}) => {
			await new Promise<void>((resolve, reject) => {
				child.send({ control, ...data }, (error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

export async function stopChild(running: RunningProcess): Promise<ProcessExit> {
	if (running.child.exitCode === null && running.child.signalCode === null) {
		running.child.kill('SIGKILL');
	}
	return withDeadline(running.exited, 5_000, 'subprocess cleanup');
}

export async function cleanupShutdownFixtures(): Promise<void> {
	await Promise.all(Array.from(runningChildren, stopChild));
	await Promise.all(
		Array.from(temporaryDirectories, async (directory) => {
			await rm(directory, { recursive: true, force: true });
			temporaryDirectories.delete(directory);
		})
	);
}

export async function createTemporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.add(directory);
	return directory;
}

export async function listenOnEphemeralPort(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new ShutdownContractFixtureError('Ephemeral listener address is unavailable');
	}
	return address.port;
}

export async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

export async function postJson(url: string, body: unknown): Promise<WireResponse> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(5_000),
	});
	return { status: response.status, body: await response.text() };
}

export function requireNumber(event: FixtureEvent, key: string): number {
	const value = event[key];
	if (typeof value !== 'number') throw new ShutdownContractFixtureError(`${key} is not a number`);
	return value;
}
