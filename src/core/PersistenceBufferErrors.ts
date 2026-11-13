import type { SessionId } from '../contracts/ids.js';
import type {
	PersistenceWork,
	PersistenceWorkFailure,
	PersistenceWorkToken,
} from '../contracts/persistence-work.js';
import { ERROR_CODES, SequentialThinkingError } from '../errors.js';
import { assertNever } from '../utils.js';
import type { PersistenceCallOutcome } from './PersistenceCallDeadline.js';

/** Error raised when an explicit persistence drain has terminal write failures. */
export class PersistenceDrainError extends SequentialThinkingError {
	/** Failures captured when the drain generation settled. */
	public readonly failures: readonly PersistenceWorkFailure[];

	constructor(failures: readonly PersistenceWorkFailure[]) {
		super(
			`Persistence drain failed with ${failures.length} terminal ${failures.length === 1 ? 'failure' : 'failures'}`,
			ERROR_CODES.PERSISTENCE_DRAIN
		);
		this.name = 'PersistenceDrainError';
		this.failures = Object.freeze([...failures]);
	}
}

/** Error raised when persistence work is submitted while a lifecycle owner holds the session. */
export class PersistenceSessionAdmissionClosedError extends SequentialThinkingError {
	/** Session whose persistence admission is closed. */
	public readonly sessionId: SessionId;

	constructor(sessionId: SessionId) {
		super(
			`Persistence admission for session '${sessionId}' is closed by a lifecycle barrier`,
			ERROR_CODES.PERSISTENCE_SESSION_ADMISSION_CLOSED
		);
		this.name = 'PersistenceSessionAdmissionClosedError';
		this.sessionId = sessionId;
	}
}

/** Error raised when an owning async call chain tries to reacquire its session barrier. */
export class PersistenceSessionBarrierReentrancyError extends SequentialThinkingError {
	/** Session already owned by the current async call chain. */
	public readonly sessionId: SessionId;

	constructor(sessionId: SessionId) {
		super(
			`Persistence lifecycle barrier for session '${sessionId}' is not reentrant`,
			ERROR_CODES.PERSISTENCE_SESSION_BARRIER_REENTRANCY
		);
		this.name = 'PersistenceSessionBarrierReentrancyError';
		this.sessionId = sessionId;
	}
}

/** Error raised when a session already holds its limit of unacknowledged thought writes. */
export class PersistenceBacklogFullError extends SequentialThinkingError {
	/** Session whose persistence backlog is full. */
	public readonly sessionId: SessionId;
	/** Unacknowledged thought and backtrack writes at the time of rejection. */
	public readonly pending: number;
	/** Configured per-session limit. */
	public readonly limit: number;

	constructor(sessionId: SessionId, pending: number, limit: number) {
		super(
			`Persistence backlog for session '${sessionId}' is full: ${pending} of ${limit} thought writes are unacknowledged. Retry after the persistence backend recovers.`,
			ERROR_CODES.PERSISTENCE_BACKLOG_FULL
		);
		this.name = 'PersistenceBacklogFullError';
		this.sessionId = sessionId;
		this.pending = pending;
		this.limit = limit;
	}
}

/** Backend call reported by a {@link PersistenceWriteTimeoutError}. */
export type PersistenceTimedOutCall =
	| {
			readonly kind: 'work';
			readonly operation: PersistenceWork['kind'];
			readonly token: PersistenceWorkToken;
			readonly sessionId: SessionId;
	  }
	| { readonly kind: 'close' };

function describeTimedOutCall(call: PersistenceTimedOutCall): string {
	switch (call.kind) {
		case 'work':
			return `${call.operation} write ${call.token} for session '${call.sessionId}'`;
		case 'close':
			return 'backend close';
		default:
			return assertNever(call);
	}
}

/**
 * Error raised when a persistence backend call outlives `persistenceWriteTimeout`.
 *
 * The call itself keeps running: `lateOutcome` settles once with its real outcome and
 * never rejects, so the caller can apply that outcome instead of sending the work again.
 */
export class PersistenceWriteTimeoutError extends SequentialThinkingError {
	/** Deadline the call exceeded, in milliseconds. */
	public readonly timeoutMs: number;
	/** Identity of the backend call that did not settle in time. */
	public readonly call: PersistenceTimedOutCall;
	/** Eventual outcome of the same backend call. */
	public readonly lateOutcome: Promise<PersistenceCallOutcome>;

	constructor(
		timeoutMs: number,
		call: PersistenceTimedOutCall,
		lateOutcome: Promise<PersistenceCallOutcome>
	) {
		super(
			`Persistence ${describeTimedOutCall(call)} did not settle within ${timeoutMs}ms`,
			ERROR_CODES.PERSISTENCE_WRITE_TIMEOUT
		);
		this.name = 'PersistenceWriteTimeoutError';
		this.timeoutMs = timeoutMs;
		this.call = Object.freeze({ ...call });
		this.lateOutcome = lateOutcome;
	}
}
