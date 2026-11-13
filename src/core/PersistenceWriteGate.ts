/**
 * Write gate of the persistence buffer: the backend calls that outlived the write deadline and
 * have not settled yet, and the reset clear currently in flight.
 *
 * @module PersistenceWriteGate
 */

import type { SessionId } from '../contracts/ids.js';
import type { PersistenceWork } from '../contracts/persistence-work.js';
import type {
	PersistenceTimedOutCall,
	PersistenceWriteTimeoutError,
} from './PersistenceBufferErrors.js';
import { assertNever } from '../utils.js';

/** Reset clear identity carried by a timed-out `clearSession` / `clearAll` call. */
export type ClearCall = Extract<PersistenceTimedOutCall, { kind: 'clearSession' | 'clearAll' }>;

/** Backend call that outlived the write deadline and has not settled yet. */
export type StalledCall =
	| {
			readonly kind: 'work';
			readonly work: PersistenceWork;
			readonly error: PersistenceWriteTimeoutError;
	  }
	| {
			readonly kind: 'clear';
			readonly call: ClearCall;
			readonly error: PersistenceWriteTimeoutError;
	  };

/** @returns The clear identity when `error` reports a timed-out reset clear. */
export function timedOutClearCall(error: PersistenceWriteTimeoutError): ClearCall | undefined {
	const { call } = error;
	switch (call.kind) {
		case 'clearSession':
		case 'clearAll':
			return call;
		case 'work':
		case 'close':
			return undefined;
		default:
			return assertNever(call);
	}
}

/** A work stall belongs to its session, `clearSession(S)` to S, and `clearAll` to every session. */
function stallBelongsTo(stall: StalledCall, sessionId: SessionId): boolean {
	switch (stall.kind) {
		case 'work':
			return stall.work.sessionId === sessionId;
		case 'clear':
			return stall.call.kind === 'clearAll' || stall.call.sessionId === sessionId;
		default:
			return assertNever(stall);
	}
}

/**
 * Insertion-ordered set of pending stalls. The gate is closed while any stall is pending and
 * the oldest stall is the one reported to callers. It also counts reset clears in flight.
 */
export class PersistenceWriteGate {
	private readonly _stalls = new Set<StalledCall>();
	private _clearsInFlight = 0;
	private _clearsSettled: PromiseWithResolvers<void> | null = null;

	/** @returns Whether any timed-out call is still pending. */
	public get isClosed(): boolean {
		return this._stalls.size > 0;
	}

	/** @returns Whether a reset clear has started and not returned to its barrier yet. */
	public get clearInFlight(): boolean {
		return this._clearsInFlight > 0;
	}

	/** @returns The error of the oldest pending stall, or `undefined` when the gate is open. */
	public oldestError(): PersistenceWriteTimeoutError | undefined {
		for (const stall of this._stalls) return stall.error;
		return undefined;
	}

	/** @returns The error of the oldest pending stall that belongs to `sessionId`. */
	public oldestErrorOf(sessionId: SessionId): PersistenceWriteTimeoutError | undefined {
		for (const stall of this._stalls) {
			if (stallBelongsTo(stall, sessionId)) return stall.error;
		}
		return undefined;
	}

	/** @returns Whether `error` already belongs to a pending stall. */
	public holds(error: PersistenceWriteTimeoutError): boolean {
		for (const stall of this._stalls) {
			if (stall.error === error) return true;
		}
		return false;
	}

	public close(stall: StalledCall): void {
		this._stalls.add(stall);
	}

	/** Drops one settled stall; the gate reopens only once no stall is pending. */
	public settle(stall: StalledCall): void {
		this._stalls.delete(stall);
	}

	/** Marks a reset clear as in flight until the returned callback runs once. */
	public beginClear(): () => void {
		this._clearsInFlight += 1;
		return () => {
			this._clearsInFlight -= 1;
			if (this._clearsInFlight > 0 || this._clearsSettled === null) return;
			this._clearsSettled.resolve();
			this._clearsSettled = null;
		};
	}

	/** @returns A promise that resolves once no reset clear is in flight. */
	public clearsSettled(): Promise<void> {
		if (!this.clearInFlight) return Promise.resolve();
		this._clearsSettled ??= Promise.withResolvers<void>();
		return this._clearsSettled.promise;
	}
}
