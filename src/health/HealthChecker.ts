/**
 * Aggregate health checking system.
 *
 * Provides liveness and readiness checks by aggregating the health
 * status of registered backend components (persistence, pool, etc.).
 *
 * @module health
 */

import type { Logger } from '../logger/StructuredLogger.js';
import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import type {
	PersistenceBacklogSource,
	PersistenceBacklogView,
} from '../contracts/persistence-backlog.js';
import { getErrorMessage } from '../errors.js';

const DEFAULT_PROBE_TIMEOUT_MS = 1000;

/**
 * Health status of an individual component.
 */
export interface HealthComponent {
	name: string;
	healthy: boolean;
	details?: string;
	latencyMs?: number;
}

/**
 * Aggregate health check result.
 */
export interface HealthCheckResult {
	status: 'ok' | 'degraded' | 'unhealthy';
	timestamp: string;
	components: Record<string, HealthComponent>;
}

/**
 * Options for constructing a HealthChecker.
 */
export interface HealthCheckerOptions {
	persistence?: PersistenceBackend | null;
	/**
	 * Reports quarantine and unflushed-work counts. Its component is omitted while the source
	 * returns `null` (persistence disabled).
	 */
	persistenceBacklog?: PersistenceBacklogSource | null;
	logger?: Logger;
	/**
	 * Deadline for `persistence.healthy()`, in milliseconds. A probe that outlives it reports the
	 * persistence component unhealthy but keeps running; later checks join it instead of starting
	 * another.
	 * @default 1000
	 */
	probeTimeoutMs?: number;
	/**
	 * How long a settled probe result is reused, in milliseconds. `0` probes on every call.
	 * @default 0
	 */
	probeFreshnessMs?: number;
}

interface SettledProbe {
	readonly component: HealthComponent;
	readonly settledAt: number;
}

function describeBacklog(view: PersistenceBacklogView): string {
	const counts =
		`quarantined sessions: ${view.quarantinedSessionCount}, ` +
		`sessions awaiting eviction retry: ${view.evictionRetrySessionCount}, ` +
		`blocked sessions: ${view.blockedSessionCount}, ` +
		`retained failures: ${view.retainedFailureCount}, ` +
		`pending thoughts: ${view.pendingThoughtCount}`;
	return view.globalQuarantined ? `Persistence is globally quarantined; ${counts}` : counts;
}

/**
 * No-op logger used when none is provided.
 */
class NoopLogger implements Pick<Logger, 'info' | 'warn' | 'error' | 'debug'> {
	info(): void {}
	warn(): void {}
	error(): void {}
	debug(): void {}
}

/**
 * Aggregates component health into liveness and readiness checks.
 *
 * - `checkLiveness()` always returns 'ok' if the process is running.
 * - `checkReadiness()` checks all registered backends and returns an aggregate status.
 *
 * @example
 * ```typescript
 * const checker = new HealthChecker({ persistence: myBackend });
 * const readiness = await checker.checkReadiness();
 * // { status: 'ok', timestamp: '...', components: { persistence: { ... } } }
 * ```
 */
export class HealthChecker {
	private _persistence: PersistenceBackend | null;
	private _backlog: PersistenceBacklogSource | null;
	private _logger: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;
	private readonly _probeTimeoutMs: number;
	private readonly _probeFreshnessMs: number;
	/** Verdict of the backend probe that has not settled yet, shared by every caller. */
	private _inFlight: Promise<HealthComponent> | null = null;
	private _settled: SettledProbe | null = null;

	constructor(options: HealthCheckerOptions = {}) {
		this._persistence = options.persistence ?? null;
		this._backlog = options.persistenceBacklog ?? null;
		this._logger = options.logger ?? new NoopLogger();
		this._probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
		this._probeFreshnessMs = options.probeFreshnessMs ?? 0;
	}

	/**
	 * Liveness check — returns 'ok' if the process is alive.
	 *
	 * This is a synchronous check that always succeeds; if this code
	 * can execute, the process is alive.
	 */
	checkLiveness(): HealthCheckResult {
		return {
			status: 'ok',
			timestamp: new Date().toISOString(),
			components: {},
		};
	}

	/**
	 * Readiness check — aggregates health of all registered backends.
	 *
	 * Checks each component and returns:
	 * - 'ok' if all components are healthy (or no components registered)
	 * - 'degraded' if some components are unhealthy
	 * - 'unhealthy' if all components are unhealthy
	 *
	 * The persistence probe is bounded by `probeTimeoutMs`, shared between concurrent calls, and
	 * reused for `probeFreshnessMs` after it settles. The backlog component is read on every call.
	 */
	async checkReadiness(): Promise<HealthCheckResult> {
		const components: Record<string, HealthComponent> = {};

		if (this._persistence) {
			components['persistence'] = { ...(await this._checkPersistence()) };
		}

		const backlog = this._checkBacklog();
		if (backlog) {
			components['persistenceBacklog'] = backlog;
		}

		const totalCount = Object.keys(components).length;
		const healthyCount = Object.values(components).filter((component) => component.healthy).length;

		// Determine aggregate status
		let status: 'ok' | 'degraded' | 'unhealthy';
		if (totalCount === 0 || healthyCount === totalCount) {
			status = 'ok';
		} else if (healthyCount === 0) {
			status = 'unhealthy';
		} else {
			status = 'degraded';
		}

		const result: HealthCheckResult = {
			status,
			timestamp: new Date().toISOString(),
			components,
		};

		if (status !== 'ok') {
			this._logger.warn('Readiness check returned non-ok status', {
				status,
				components,
			});
		}

		return result;
	}

	/**
	 * Persistence component from the freshest source available: a settled result still inside
	 * the freshness window, else the probe already running (even past its deadline), else a new
	 * probe.
	 */
	private async _checkPersistence(): Promise<HealthComponent> {
		const settled = this._settled;
		if (settled !== null && Date.now() - settled.settledAt < this._probeFreshnessMs) {
			return settled.component;
		}
		this._inFlight ??= this._startProbe();
		return this._inFlight;
	}

	/**
	 * Start one backend probe. The backend call is never abandoned: it stays tracked until it
	 * settles, while the returned verdict resolves at that point or at the deadline, whichever
	 * comes first.
	 */
	private _startProbe(): Promise<HealthComponent> {
		const settled = this._probeBackend().then((component) => {
			this._inFlight = null;
			this._settled = { component, settledAt: Date.now() };
			return component;
		});
		return new Promise<HealthComponent>((resolve) => {
			const timer = setTimeout(() => {
				resolve({
					name: 'persistence',
					healthy: false,
					latencyMs: this._probeTimeoutMs,
					details: `Health check timed out after ${this._probeTimeoutMs}ms`,
				});
			}, this._probeTimeoutMs);
			timer.unref();
			void settled.then((component) => {
				clearTimeout(timer);
				resolve(component);
			});
		});
	}

	private _checkBacklog(): HealthComponent | null {
		const view = this._backlog?.getPersistenceBacklogView() ?? null;
		if (view === null) {
			return null;
		}
		return {
			name: 'persistenceBacklog',
			healthy: !view.globalQuarantined,
			details: describeBacklog(view),
		};
	}

	/**
	 * Probe the persistence backend with latency measurement. Never rejects: every failure,
	 * including a rejection that arrives after the deadline, becomes an unhealthy component.
	 */
	private async _probeBackend(): Promise<HealthComponent> {
		const start = Date.now();
		try {
			const healthy = await this._persistence!.healthy();
			return {
				name: 'persistence',
				healthy,
				latencyMs: Date.now() - start,
				details: healthy ? 'Backend is responsive' : 'Backend reported unhealthy',
			};
		} catch (error) {
			this._logger.error('Persistence health check failed', {
				error: getErrorMessage(error),
			});
			return {
				name: 'persistence',
				healthy: false,
				latencyMs: Date.now() - start,
				details: `Health check error: ${getErrorMessage(error)}`,
			};
		}
	}
}
