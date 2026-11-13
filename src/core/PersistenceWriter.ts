/**
 * Bounded persistence dispatch for one accepted work item.
 *
 * @module PersistenceWriter
 */

import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import type { PersistenceWork, PersistenceWorkFailure } from '../contracts/persistence-work.js';
import { assertNever } from '../utils.js';
import { callWithinDeadline, type PersistenceCallOutcome } from './PersistenceCallDeadline.js';
import { PersistenceWriteTimeoutError } from './PersistenceBufferErrors.js';

const DEFAULT_RETRY_DELAYS = [100, 500, 2000] as const;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Async scheduler used between persistence attempts. */
export type PersistenceDelay = (milliseconds: number) => Promise<void>;

/** Immutable dependencies and retry policy for {@link PersistenceWriter}. */
export type PersistenceWriterConfig = {
	readonly persistence: PersistenceBackend;
	readonly maxRetries: number;
	readonly retryDelays?: readonly number[];
	readonly delay?: PersistenceDelay;
	/** Per-call deadline in milliseconds; `undefined` waits on every call without a deadline. */
	readonly writeTimeout?: number;
};

/** Allocation-free success sentinel or an attributable terminal failure. */
export type PersistenceWriteResult = true | PersistenceWorkFailure;

type AttemptOutcome =
	| PersistenceCallOutcome
	| { readonly kind: 'timedOut'; readonly error: PersistenceWriteTimeoutError };

function defaultDelay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Writes one sealed persistence item with a bounded retry policy.
 *
 * The writer owns no queue or generation state. Each call preserves the work
 * coordinates and delegates retention or error aggregation to its caller.
 *
 * With `writeTimeout`, an attempt that has not settled by the deadline ends the write:
 * the failure's cause is a {@link PersistenceWriteTimeoutError} whose `lateOutcome`
 * reports the same backend call, and no further attempt is dispatched.
 *
 * @example
 * ```ts
 * const writer = new PersistenceWriter({ persistence, maxRetries: 0 });
 * const result = await writer.write(work);
 * if (result !== true) failures.push(result);
 * ```
 */
export class PersistenceWriter {
	private readonly _persistence: PersistenceBackend;
	private readonly _maxRetries: number;
	private readonly _retryDelays: readonly number[];
	private readonly _delay: PersistenceDelay;
	private readonly _writeTimeout: number | undefined;

	/**
	 * Creates a bounded writer.
	 *
	 * @param config - Persistence dependency, retry bound, cadence, delay scheduler, and deadline.
	 * @throws {RangeError} When `maxRetries` is not a non-negative safe integer, or when
	 * `writeTimeout` is not a finite number above 0 and at most 2147483647.
	 */
	public constructor(config: PersistenceWriterConfig) {
		if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0) {
			throw new RangeError('maxRetries must be a non-negative safe integer');
		}
		const timeout = config.writeTimeout;
		if (timeout !== undefined && !(timeout > 0 && timeout <= MAX_TIMER_DELAY_MS)) {
			throw new RangeError(`writeTimeout must be above 0 and at most ${MAX_TIMER_DELAY_MS}`);
		}

		this._persistence = config.persistence;
		this._maxRetries = config.maxRetries;
		this._retryDelays = [...(config.retryDelays ?? DEFAULT_RETRY_DELAYS)];
		this._delay = config.delay ?? defaultDelay;
		this._writeTimeout = timeout;
	}

	/**
	 * Writes one item once initially and at most `maxRetries` additional times.
	 *
	 * @param work - Sealed persistence item selected by the coordinator.
	 * @returns `true` on success, or the exact attributable failure after exhaustion.
	 */
	public async write(work: PersistenceWork): Promise<PersistenceWriteResult> {
		let finalCause: unknown;

		for (let attemptIndex = 0; attemptIndex <= this._maxRetries; attemptIndex++) {
			if (attemptIndex > 0) {
				await this._delay(this._retryDelay(attemptIndex - 1));
			}

			const timeoutMs = this._writeTimeout;
			if (timeoutMs === undefined) {
				try {
					await this._dispatch(work);
					return true;
				} catch (cause) {
					finalCause = cause;
				}
				continue;
			}

			const outcome = await this._attemptWithinDeadline(work, timeoutMs);
			switch (outcome.kind) {
				case 'fulfilled':
					return true;
				case 'rejected':
					finalCause = outcome.reason;
					break;
				case 'timedOut':
					return this._failure(work, attemptIndex + 1, outcome.error);
				default:
					return assertNever(outcome);
			}
		}

		return this._failure(work, this._maxRetries + 1, finalCause);
	}

	private _retryDelay(retryIndex: number): number {
		return this._retryDelays[retryIndex] ?? this._retryDelays.at(-1) ?? 0;
	}

	private async _attemptWithinDeadline(
		work: PersistenceWork,
		timeoutMs: number
	): Promise<AttemptOutcome> {
		const outcome = await callWithinDeadline(() => this._dispatch(work), timeoutMs);
		if (outcome.kind !== 'timedOut') return outcome;
		const call = {
			kind: 'work',
			operation: work.kind,
			token: work.token,
			sessionId: work.sessionId,
		} as const;
		return {
			kind: 'timedOut',
			error: new PersistenceWriteTimeoutError(timeoutMs, call, outcome.lateOutcome),
		};
	}

	private async _dispatch(work: PersistenceWork): Promise<void> {
		switch (work.kind) {
			case 'thought':
				return this._persistence.saveThoughtForSession(work.sessionId, work.thought);
			case 'backtrack':
				return this._persistence.saveBacktrackForSession(
					work.sessionId,
					work.thought,
					work.targetThoughtId
				);
			case 'branch':
				if (work.operation === 'delete') {
					return this._persistence.deleteBranchForSession(work.sessionId, work.key);
				}
				return this._persistence.saveBranchForSession(work.sessionId, work.key, work.snapshot);
			case 'edge':
				return this._persistence.saveEdges(work.sessionId, work.snapshot);
			case 'summary':
				return this._persistence.saveSummaries(work.sessionId, work.snapshot);
			default:
				return assertNever(work);
		}
	}

	private _failure(
		work: PersistenceWork,
		attempts: number,
		cause: unknown
	): PersistenceWorkFailure {
		switch (work.kind) {
			case 'thought':
			case 'backtrack':
				return { kind: work.kind, token: work.token, sessionId: work.sessionId, attempts, cause };
			case 'branch':
				return {
					kind: work.kind,
					operation: work.operation,
					token: work.token,
					sessionId: work.sessionId,
					key: work.key,
					version: work.version,
					attempts,
					cause,
				};
			case 'edge':
				return {
					kind: work.kind,
					token: work.token,
					sessionId: work.sessionId,
					key: work.key,
					version: work.version,
					attempts,
					cause,
				};
			case 'summary':
				return {
					kind: work.kind,
					token: work.token,
					sessionId: work.sessionId,
					key: work.key,
					version: work.version,
					attempts,
					cause,
				};
			default:
				return assertNever(work);
		}
	}
}
