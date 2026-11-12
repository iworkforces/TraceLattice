import type { SessionId, ThoughtId } from '../../contracts/ids.js';
import type { ThoughtData } from '../../core/thought.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';

/**
 * Memory backend whose thought writes and scoped deletes can be switched off from a test.
 * It extends the production memory sink so contract changes to `PersistenceBackend` apply here.
 */
export class StallingPersistence extends MemoryPersistence {
	public down = false;
	public failClear = false;
	public thoughtAttempts = 0;

	public override async saveThoughtForSession(
		sessionId: SessionId,
		thought: ThoughtData
	): Promise<void> {
		this.thoughtAttempts += 1;
		if (this.down) throw new Error('backend down');
		await super.saveThoughtForSession(sessionId, thought);
	}

	public override async saveBacktrackForSession(
		sessionId: SessionId,
		thought: ThoughtData,
		targetThoughtId: ThoughtId
	): Promise<void> {
		this.thoughtAttempts += 1;
		if (this.down) throw new Error('backend down');
		await super.saveBacktrackForSession(sessionId, thought, targetThoughtId);
	}

	public override async clearSession(sessionId: SessionId): Promise<void> {
		if (this.failClear) throw new Error('delete failed');
		await super.clearSession(sessionId);
	}
}
