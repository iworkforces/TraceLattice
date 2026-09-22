/**
 * Bounded persistence dispatch for one accepted work item.
 *
 * @module PersistenceWriter
 */

import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import type { PersistenceWork, PersistenceWorkFailure } from '../contracts/persistence-work.js';
import { assertNever } from '../utils.js';

const DEFAULT_RETRY_DELAYS = [100, 500, 2000] as const;

/** Async scheduler used between persistence attempts. */
export type PersistenceDelay = (milliseconds: number) => Promise<void>;

/** Immutable dependencies and retry policy for {@link PersistenceWriter}. */
export type PersistenceWriterConfig = {
	readonly persistence: PersistenceBackend;
	readonly maxRetries: number;
	readonly retryDelays?: readonly number[];
	readonly delay?: PersistenceDelay;
};

/** Allocation-free success sentinel or an attributable terminal failure. */
export type PersistenceWriteResult = true | PersistenceWorkFailure;

function defaultDelay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Writes one sealed persistence item with a bounded retry policy.
 *
 * The writer owns no queue or generation state. Each call preserves the work
 * coordinates and delegates retention or error aggregation to its caller.
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

	/**
	 * Creates a bounded writer.
	 *
	 * @param config - Persistence dependency, retry bound, cadence, and delay scheduler.
	 * @throws {RangeError} When `maxRetries` is not a non-negative safe integer.
	 */
	public constructor(config: PersistenceWriterConfig) {
		if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0) {
			throw new RangeError('maxRetries must be a non-negative safe integer');
		}

		this._persistence = config.persistence;
		this._maxRetries = config.maxRetries;
		this._retryDelays = [...(config.retryDelays ?? DEFAULT_RETRY_DELAYS)];
		this._delay = config.delay ?? defaultDelay;
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

			try {
				await this._dispatch(work);
				return true;
			} catch (cause) {
				finalCause = cause;
			}
		}

		return this._failure(work, this._maxRetries + 1, finalCause);
	}

	private _retryDelay(retryIndex: number): number {
		return this._retryDelays[retryIndex] ?? this._retryDelays.at(-1) ?? 0;
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
