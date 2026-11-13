import { DEFAULT_SHUTDOWN_DEADLINE_MS } from './config/CliTransportConfig.js';
import { CliShutdownTimeoutError, TransportStopTimeoutError } from './errors.js';

export const CLI_SHUTDOWN_DEADLINE_MS = DEFAULT_SHUTDOWN_DEADLINE_MS;

export interface CliOwnedResource {
	/** Stops within `timeoutMs`, the budget from `serverStopBudgetMs` of the total deadline. */
	stop(timeoutMs: number): void | Promise<void>;
}

export interface CliTransportResource {
	stop(timeoutMs: number): void | Promise<void>;
}

export interface CliShutdownBoundary {
	reportFailure(error: unknown): void;
	exit(code: 0 | 1): void;
}

export interface CliLifecycleOptions {
	readonly deadlineMs?: number;
	readonly clock?: CliLifecycleClock;
}

export interface CliLifecycleClock {
	setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
	clearTimeout(handle: NodeJS.Timeout): void;
}

const SYSTEM_CLOCK: CliLifecycleClock = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle),
};

const SHUTDOWN_FAILURE_MESSAGE = 'CLI shutdown did not complete cleanly';

export function transportStopSliceMs(totalMs: number): number {
	return Math.max(1, Math.floor(totalMs / 2));
}

/**
 * The server stop's own budget inside a total shutdown deadline: what is left after the transport
 * slice and a reserve of a tenth of the deadline (at most 1000 ms). The total timer is armed before
 * the transport phase and the server's timers only after it, so a budget of `total - slice` could
 * never expire first; the reserve lets a server that honours its budget report its own typed error
 * before the total deadline, and also absorbs event-loop lag on the slice guard. Below roughly
 * 100 ms the reserve is smaller than timer lag, so the total deadline can win and report
 * `CLI_SHUTDOWN_TIMEOUT`, as before this budget existed.
 */
export function serverStopBudgetMs(totalMs: number): number {
	const reserveMs = Math.min(1000, Math.floor(totalMs / 10));
	return Math.max(1, totalMs - transportStopSliceMs(totalMs) - reserveMs);
}

function appendFailure(failures: unknown[], failure: unknown): void {
	if (failure instanceof AggregateError) {
		for (const nestedFailure of failure.errors) appendFailure(failures, nestedFailure);
		return;
	}
	failures.push(failure);
}

function collectFailures(first: readonly unknown[], second: readonly unknown[]): unknown[] {
	const failures: unknown[] = [];
	for (const failure of [...first, ...second]) appendFailure(failures, failure);
	return failures;
}

async function invoke(stop: () => void | Promise<void>): Promise<void> {
	await stop();
}

/**
 * Starts `stop` at once, then arms a guard that rejects with `TransportStopTimeoutError` when
 * `stop` has not settled after `timeoutMs`. The guard is armed second so that a stopper with its
 * own timer of the same length settles first and its typed error wins.
 */
export function stopWithin(
	stop: () => void | Promise<void>,
	timeoutMs: number,
	clock: CliLifecycleClock = SYSTEM_CLOCK
): Promise<void> {
	const guard = Promise.withResolvers<void>();
	const stopping = invoke(stop);
	const timer = clock.setTimeout(
		() => guard.reject(new TransportStopTimeoutError(timeoutMs, null)),
		timeoutMs
	);
	return Promise.race([stopping, guard.promise]).finally(() => clock.clearTimeout(timer));
}

/**
 * The transport phase of one shutdown. `settled` never rejects and resolves when the transport
 * stopped, failed, or overran its slice; `failures()` reports the transport's own failure once it
 * has rejected and the slice guard's error otherwise, so an overrun slice stays a failure even
 * when the transport stops cleanly afterwards.
 */
class TransportStopRun {
	readonly settled: Promise<void>;
	private _real: readonly unknown[] | null = null;
	private _guard: readonly unknown[] = [];

	constructor(transport: CliTransportResource, sliceMs: number, clock: CliLifecycleClock) {
		this.settled = stopWithin(
			async () => {
				try {
					await transport.stop(sliceMs);
					this._real = [];
				} catch (error) {
					this._real = [error];
					throw error;
				}
			},
			sliceMs,
			clock
		).then(
			() => undefined,
			(error: unknown) => {
				if (this._real === null) this._guard = [error];
			}
		);
	}

	failures(): readonly unknown[] {
		return this._real !== null && this._real.length > 0 ? this._real : this._guard;
	}
}

export class CliLifecycle {
	private readonly _server: CliOwnedResource;
	private readonly _deadlineMs: number;
	private readonly _clock: CliLifecycleClock;
	private _transport: CliTransportResource | null = null;
	private _shutdownPromise: Promise<void> | null = null;

	constructor(server: CliOwnedResource, options: CliLifecycleOptions = {}) {
		this._server = server;
		this._deadlineMs = options.deadlineMs ?? CLI_SHUTDOWN_DEADLINE_MS;
		this._clock = options.clock ?? SYSTEM_CLOCK;
	}

	attachTransport(transport: CliTransportResource): void {
		if (this._transport) throw new TypeError('CLI transport owner is already attached');
		this._transport = transport;
	}

	shutdown(): Promise<void> {
		if (this._shutdownPromise) return this._shutdownPromise;
		const completion = Promise.withResolvers<void>();
		this._shutdownPromise = completion.promise;
		void this._stopAll().then(completion.resolve, completion.reject);
		return this._shutdownPromise;
	}

	async rollbackStartup(startupFailure: unknown): Promise<never> {
		const rollbackFailure = await this.shutdown().then(
			() => null,
			(error: unknown) => error
		);
		if (rollbackFailure === null) throw startupFailure;
		const failures = [startupFailure];
		appendFailure(failures, rollbackFailure);
		throw new AggregateError(failures, 'CLI startup failed and rollback did not complete cleanly');
	}

	private async _stopAll(): Promise<void> {
		const expiry = Promise.withResolvers<void>();
		const timer = this._clock.setTimeout(() => expiry.resolve(), this._deadlineMs);
		const transportRun = this._transport
			? new TransportStopRun(this._transport, transportStopSliceMs(this._deadlineMs), this._clock)
			: null;
		try {
			await this._stopWithinBudget(transportRun, expiry.promise);
		} finally {
			this._clock.clearTimeout(timer);
		}
	}

	private async _stopWithinBudget(
		transportRun: TransportStopRun | null,
		expired: Promise<void>
	): Promise<void> {
		if (transportRun) await Promise.race([transportRun.settled, expired]);
		const budgetMs = serverStopBudgetMs(this._deadlineMs);
		const serverStopped = invoke(() => this._server.stop(budgetMs)).then(
			() => [],
			(error: unknown) => [error]
		);
		const serverFailures = await Promise.race([serverStopped, expired.then(() => null)]);
		const transportFailures = transportRun?.failures() ?? [];
		if (serverFailures === null) throw this._timeoutFailure(transportFailures);
		const failures = collectFailures(transportFailures, serverFailures);
		if (failures.length > 0) throw new AggregateError(failures, SHUTDOWN_FAILURE_MESSAGE);
	}

	private _timeoutFailure(transportFailures: readonly unknown[]): Error {
		const timeout = new CliShutdownTimeoutError(this._deadlineMs);
		if (transportFailures.length === 0) return timeout;
		return new AggregateError(
			collectFailures(transportFailures, [timeout]),
			SHUTDOWN_FAILURE_MESSAGE
		);
	}
}

export function createCliShutdownHandler(
	lifecycle: CliLifecycle,
	boundary: CliShutdownBoundary
): () => Promise<void> {
	let handlerPromise: Promise<void> | null = null;
	return (): Promise<void> => {
		if (handlerPromise) return handlerPromise;
		handlerPromise = lifecycle.shutdown().then(
			() => boundary.exit(0),
			(error: unknown) => {
				boundary.reportFailure(error);
				boundary.exit(1);
			}
		);
		return handlerPromise;
	};
}
