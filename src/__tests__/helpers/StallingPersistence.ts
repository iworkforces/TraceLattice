import type { SessionId, ThoughtId } from '../../contracts/ids.js';
import type { ThoughtData } from '../../core/thought.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';

/**
 * Memory backend whose thought writes and scoped deletes can be switched off from a test.
 * It extends the production memory sink so contract changes to `PersistenceBackend` apply here.
 *
 * With `holdWrites` or `holdClose` set, the matching calls stay unsettled until the test
 * releases them in call order with {@link StallingPersistence.releaseHeldCall}. A held write
 * released as a success stores its thought; one released with an error stores nothing.
 */
export class StallingPersistence extends MemoryPersistence {
	public down = false;
	public failClear = false;
	public thoughtAttempts = 0;
	public holdWrites = false;
	public holdClose = false;
	public closeCalls = 0;
	private readonly _held: PromiseWithResolvers<void>[] = [];

	/** Number of held calls the test has not released yet. */
	public get heldCallCount(): number {
		return this._held.length;
	}

	/**
	 * Settles the oldest held call.
	 *
	 * @param failure - Rejects the call with this error; omitted, the call proceeds as a success.
	 * @throws {Error} When no call is held.
	 */
	public releaseHeldCall(failure?: Error): void {
		const held = this._held.shift();
		if (held === undefined) throw new Error('no held persistence call to release');
		if (failure === undefined) held.resolve();
		else held.reject(failure);
	}

	public override async saveThoughtForSession(
		sessionId: SessionId,
		thought: ThoughtData
	): Promise<void> {
		this.thoughtAttempts += 1;
		if (this.down) throw new Error('backend down');
		if (this.holdWrites) await this._hold();
		await super.saveThoughtForSession(sessionId, thought);
	}

	public override async saveBacktrackForSession(
		sessionId: SessionId,
		thought: ThoughtData,
		targetThoughtId: ThoughtId
	): Promise<void> {
		this.thoughtAttempts += 1;
		if (this.down) throw new Error('backend down');
		if (this.holdWrites) await this._hold();
		await super.saveBacktrackForSession(sessionId, thought, targetThoughtId);
	}

	public override async clearSession(sessionId: SessionId): Promise<void> {
		if (this.failClear) throw new Error('delete failed');
		await super.clearSession(sessionId);
	}

	public override async close(): Promise<void> {
		this.closeCalls += 1;
		if (this.holdClose) await this._hold();
		await super.close();
	}

	private _hold(): Promise<void> {
		const held = Promise.withResolvers<void>();
		this._held.push(held);
		return held.promise;
	}
}
