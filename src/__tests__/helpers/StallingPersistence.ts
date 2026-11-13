import type { BranchId, SessionId, ThoughtId } from '../../contracts/ids.js';
import type { Summary } from '../../core/compression/Summary.js';
import type { Edge } from '../../core/graph/Edge.js';
import type { ThoughtData } from '../../core/thought.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';

/**
 * Memory backend whose thought writes and scoped deletes can be switched off from a test.
 * It extends the production memory sink so contract changes to `PersistenceBackend` apply here.
 *
 * With `holdWrites`, `holdClears` or `holdClose` set, the matching calls stay unsettled until the
 * test releases them in call order with {@link StallingPersistence.releaseHeldCall}. A held call
 * released as a success takes effect; one released with an error changes nothing.
 * `holdWrites` covers every write: thought, backtrack, branch save and delete, edges, summaries.
 * `maxConcurrentCalls` counts writes and clears together that were unsettled at the same time.
 * `writesStartedDuringClear` counts writes that reached the backend while a clear was unsettled.
 */
export class StallingPersistence extends MemoryPersistence {
	public down = false;
	public failClear = false;
	public thoughtAttempts = 0;
	public holdWrites = false;
	public holdClears = false;
	public holdClose = false;
	public closeCalls = 0;
	public clearCalls = 0;
	public maxConcurrentWrites = 0;
	public maxConcurrentCalls = 0;
	public writesStartedDuringClear = 0;
	private _concurrentWrites = 0;
	private _concurrentClears = 0;
	private _concurrentCalls = 0;
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
		await this._write(() => super.saveThoughtForSession(sessionId, thought));
	}

	public override async saveBacktrackForSession(
		sessionId: SessionId,
		thought: ThoughtData,
		targetThoughtId: ThoughtId
	): Promise<void> {
		this.thoughtAttempts += 1;
		if (this.down) throw new Error('backend down');
		await this._write(() => super.saveBacktrackForSession(sessionId, thought, targetThoughtId));
	}

	public override saveBranchForSession(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): Promise<void> {
		return this._write(() => super.saveBranchForSession(sessionId, branchId, thoughts));
	}

	public override deleteBranchForSession(sessionId: SessionId, branchId: BranchId): Promise<void> {
		return this._write(() => super.deleteBranchForSession(sessionId, branchId));
	}

	public override saveEdges(sessionId: SessionId, edges: readonly Edge[]): Promise<void> {
		return this._write(() => super.saveEdges(sessionId, edges));
	}

	public override saveSummaries(
		sessionId: SessionId,
		summaries: readonly Summary[]
	): Promise<void> {
		return this._write(() => super.saveSummaries(sessionId, summaries));
	}

	public override async clearSession(sessionId: SessionId): Promise<void> {
		this.clearCalls += 1;
		if (this.failClear) throw new Error('delete failed');
		this._startCall();
		this._concurrentClears += 1;
		try {
			if (this.holdClears) await this._hold();
			await super.clearSession(sessionId);
		} finally {
			this._concurrentClears -= 1;
			this._concurrentCalls -= 1;
		}
	}

	public override async clearAll(): Promise<void> {
		this.clearCalls += 1;
		this._startCall();
		this._concurrentClears += 1;
		try {
			if (this.holdClears) await this._hold();
			await super.clearAll();
		} finally {
			this._concurrentClears -= 1;
			this._concurrentCalls -= 1;
		}
	}

	public override async close(): Promise<void> {
		this.closeCalls += 1;
		if (this.holdClose) await this._hold();
		await super.close();
	}

	private async _write(write: () => Promise<void>): Promise<void> {
		this._concurrentWrites += 1;
		this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this._concurrentWrites);
		if (this._concurrentClears > 0) this.writesStartedDuringClear += 1;
		this._startCall();
		try {
			if (this.holdWrites) await this._hold();
			await write();
		} finally {
			this._concurrentWrites -= 1;
			this._concurrentCalls -= 1;
		}
	}

	private _startCall(): void {
		this._concurrentCalls += 1;
		this.maxConcurrentCalls = Math.max(this.maxConcurrentCalls, this._concurrentCalls);
	}

	private _hold(): Promise<void> {
		const held = Promise.withResolvers<void>();
		this._held.push(held);
		return held.promise;
	}
}
