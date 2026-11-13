import type { ServerResponse } from 'node:http';
import { TransportStopTimeoutError } from '../errors.js';

type ResponseWriter = (response: ServerResponse) => void;
type WorkFailureHandler = (error: unknown) => void;

export type PreDispatchCancellationReason = 'peer' | 'shutdown' | 'timeout';

export interface PreDispatchLease {
	readonly signal: AbortSignal;
	readonly cancellationReason: PreDispatchCancellationReason | null;
	cancel(reason: PreDispatchCancellationReason): void;
	release(): void;
}

class TrackedPreDispatchLease implements PreDispatchLease {
	private readonly _controller = new AbortController();
	private readonly _settled = Promise.withResolvers<void>();
	private _active = true;
	private _cancellationReason: PreDispatchCancellationReason | null = null;

	constructor(private readonly _onRelease: (lease: TrackedPreDispatchLease) => void) {}

	get signal(): AbortSignal {
		return this._controller.signal;
	}

	get cancellationReason(): PreDispatchCancellationReason | null {
		return this._cancellationReason;
	}

	get settled(): Promise<void> {
		return this._settled.promise;
	}

	cancel(reason: PreDispatchCancellationReason): void {
		if (!this._active || this._controller.signal.aborted) return;
		this._cancellationReason = reason;
		this._controller.abort();
	}

	release(): void {
		if (!this._active) return;
		this._active = false;
		this._onRelease(this);
		this._settled.resolve();
	}
}

export class PreDispatchTracker {
	private readonly _leases = new Set<TrackedPreDispatchLease>();
	private _accepting = true;

	acquire(): PreDispatchLease | null {
		if (!this._accepting) return null;
		const lease = new TrackedPreDispatchLease((released) => this._leases.delete(released));
		this._leases.add(lease);
		return lease;
	}

	closeAdmission(reason: PreDispatchCancellationReason): void {
		this._accepting = false;
		for (const lease of this._leases) lease.cancel(reason);
	}

	async join(): Promise<void> {
		while (this._leases.size > 0) {
			await Promise.all([...this._leases].map((lease) => lease.settled));
		}
	}
}

export type LifecycleReportingFailure = {
	readonly lifecycleError: unknown;
	readonly reportingError: unknown;
};

/** Maximum number of reporting failures retained for diagnostics. */
export const LIFECYCLE_REPORTING_FAILURE_CAPACITY = 32;

export class LifecycleFailureReporter {
	private readonly _reportingFailures: LifecycleReportingFailure[] = [];
	private _reportingFailureCount = 0;
	private _droppedReportingFailureCount = 0;

	constructor(private readonly _onFailure: WorkFailureHandler) {}

	get reportingFailures(): readonly LifecycleReportingFailure[] {
		return [...this._reportingFailures];
	}

	get reportingFailureCount(): number {
		return this._reportingFailureCount;
	}

	get droppedReportingFailureCount(): number {
		return this._droppedReportingFailureCount;
	}

	report(error: unknown): void {
		try {
			this._onFailure(error);
		} catch (reportingError) {
			this._reportingFailureCount++;
			if (this._reportingFailures.length === LIFECYCLE_REPORTING_FAILURE_CAPACITY) {
				this._reportingFailures.shift();
				this._droppedReportingFailureCount++;
			}
			this._reportingFailures.push({ lifecycleError: error, reportingError });
		}
	}
}

export class ResponseFinalizer {
	private _isFinalized = false;

	constructor(
		private readonly _response: ServerResponse,
		private readonly _failureReporter: LifecycleFailureReporter
	) {
		this._response.once('close', () => {
			this._isFinalized = true;
		});
	}

	finalize(writer: ResponseWriter): boolean {
		if (this._isFinalized || this._response.destroyed || this._response.writableEnded) {
			this._isFinalized = true;
			return false;
		}

		this._isFinalized = true;
		try {
			writer(this._response);
		} catch (error) {
			this._failureReporter.report(error);
			this._response.destroy();
		}
		return true;
	}
}

export class AcceptedWorkTracker {
	private readonly _work = new Set<Promise<void>>();

	constructor(private readonly _failureReporter: LifecycleFailureReporter) {}

	get size(): number {
		return this._work.size;
	}

	transfer(lease: PreDispatchLease, start: () => Promise<void>): Promise<void> {
		lease.signal.throwIfAborted();
		const reservation = Promise.withResolvers<void>();
		this._work.add(reservation.promise);
		lease.release();

		let work: Promise<void>;
		try {
			work = start();
		} catch (error) {
			this._work.delete(reservation.promise);
			reservation.resolve();
			throw error;
		}

		const observed = work.catch((error: unknown) => {
			this._failureReporter.report(error);
		});
		void observed.then(() => {
			this._work.delete(reservation.promise);
			reservation.resolve();
		});
		return work;
	}

	async join(): Promise<void> {
		while (this._work.size > 0) {
			await Promise.all(this._work);
		}
	}
}

export interface StopDeadline {
	readonly timeoutMs: number;
	readonly acceptedWork: AcceptedWorkTracker;
	readonly forceClose: () => void;
}

/**
 * Settles with `joined` when it settles first. At the deadline this timer, not socket teardown,
 * settles the result: it rejects while accepted work is still pending and resolves otherwise.
 */
export function boundStop(joined: Promise<void>, deadline: StopDeadline): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			const abandonedRequests = deadline.acceptedWork.size;
			try {
				deadline.forceClose();
			} finally {
				if (abandonedRequests > 0) {
					reject(new TransportStopTimeoutError(deadline.timeoutMs, abandonedRequests));
				} else {
					resolve();
				}
			}
		}, deadline.timeoutMs);
		void joined.then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}
