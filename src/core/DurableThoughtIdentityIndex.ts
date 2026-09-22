import type { BranchId, SessionId, ThoughtId } from '../contracts/ids.js';
import { assertNever } from '../utils.js';
import type { ThoughtData } from './thought.js';

export type DurableHistoryRetention =
	{ readonly kind: 'bounded'; readonly maxHistorySize: number } | { readonly kind: 'unlimited' };

export function normalizeDurableHistoryRetention(maxHistorySize: number): DurableHistoryRetention {
	return maxHistorySize > 0 ? { kind: 'bounded', maxHistorySize } : { kind: 'unlimited' };
}

export type DurableIdentityBranch = {
	readonly branchId: BranchId;
	readonly thoughts: readonly ThoughtData[];
};

export type DurableIdentitySession = {
	readonly sessionId: SessionId;
	readonly history: readonly ThoughtData[];
	readonly branches: readonly DurableIdentityBranch[];
};

type SessionIdentities = {
	readonly history: ThoughtId[];
	readonly branches: Map<BranchId, readonly ThoughtId[]>;
	readonly counts: Map<ThoughtId, number>;
};

export class DurableThoughtIdentityIndex {
	private readonly _sessions = new Map<SessionId, SessionIdentities>();

	public constructor(private readonly _historyRetention: DurableHistoryRetention) {}

	public has(sessionId: SessionId, thoughtId: ThoughtId): boolean {
		return this._sessions.get(sessionId)?.counts.has(thoughtId) === true;
	}

	public appendThought(sessionId: SessionId, thought: ThoughtData): void {
		if (thought.id === undefined) return;
		const session = this._session(sessionId);
		session.history.push(thought.id);
		this._add(session, thought.id);
		switch (this._historyRetention.kind) {
			case 'unlimited':
				return;
			case 'bounded':
				while (session.history.length > this._historyRetention.maxHistorySize) {
					const removed = session.history.shift();
					if (removed !== undefined) this._remove(session, removed);
				}
				return;
			default:
				assertNever(this._historyRetention);
		}
	}

	public replaceBranch(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): void {
		const session = this._session(sessionId);
		for (const thoughtId of session.branches.get(branchId) ?? []) this._remove(session, thoughtId);
		const replacement = thoughts.flatMap((thought) =>
			thought.id === undefined ? [] : [thought.id]
		);
		if (replacement.length === 0) session.branches.delete(branchId);
		else session.branches.set(branchId, replacement);
		for (const thoughtId of replacement) this._add(session, thoughtId);
		this._deleteEmptySession(sessionId, session);
	}

	public deleteBranch(sessionId: SessionId, branchId: BranchId): void {
		const session = this._sessions.get(sessionId);
		if (session === undefined) return;
		for (const thoughtId of session.branches.get(branchId) ?? []) this._remove(session, thoughtId);
		session.branches.delete(branchId);
		this._deleteEmptySession(sessionId, session);
	}

	public replaceAll(sessions: readonly DurableIdentitySession[]): void {
		this._sessions.clear();
		for (const session of sessions) {
			for (const thought of session.history) this.appendThought(session.sessionId, thought);
			for (const branch of session.branches) {
				this.replaceBranch(session.sessionId, branch.branchId, branch.thoughts);
			}
		}
	}

	public clearSession(sessionId: SessionId): void {
		this._sessions.delete(sessionId);
	}

	public clearAll(): void {
		this._sessions.clear();
	}

	private _session(sessionId: SessionId): SessionIdentities {
		const existing = this._sessions.get(sessionId);
		if (existing !== undefined) return existing;
		const created: SessionIdentities = {
			history: [],
			branches: new Map(),
			counts: new Map(),
		};
		this._sessions.set(sessionId, created);
		return created;
	}

	private _add(session: SessionIdentities, thoughtId: ThoughtId): void {
		session.counts.set(thoughtId, (session.counts.get(thoughtId) ?? 0) + 1);
	}

	private _remove(session: SessionIdentities, thoughtId: ThoughtId): void {
		const count = session.counts.get(thoughtId);
		if (count === undefined) return;
		if (count > 1) session.counts.set(thoughtId, count - 1);
		else session.counts.delete(thoughtId);
	}

	private _deleteEmptySession(sessionId: SessionId, session: SessionIdentities): void {
		if (session.history.length === 0 && session.branches.size === 0) {
			this._sessions.delete(sessionId);
		}
	}
}
