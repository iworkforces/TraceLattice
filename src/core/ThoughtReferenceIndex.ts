import type { SessionId, ThoughtId } from '../contracts/ids.js';
import type { ThoughtData } from './thought.js';

export type ThoughtReferenceResolution =
	| { readonly kind: 'missing' }
	| { readonly kind: 'unique'; readonly thoughtId: ThoughtId }
	| { readonly kind: 'ambiguous'; readonly thoughtIds: readonly ThoughtId[] };

const MISSING: ThoughtReferenceResolution = Object.freeze({ kind: 'missing' });

/** Ref-counted stable-ID lookup for retained thoughts in each session. */
export class ThoughtReferenceIndex {
	private readonly _sessions = new Map<SessionId, Map<number, Map<ThoughtId, number>>>();
	private readonly _identities = new Map<SessionId, Map<ThoughtId, number>>();

	public add(sessionId: SessionId, thought: ThoughtData): void {
		if (thought.id === undefined) return;
		let session = this._sessions.get(sessionId);
		if (session === undefined) {
			session = new Map();
			this._sessions.set(sessionId, session);
		}
		this._addToSession(session, thought);
		this._addIdentity(sessionId, thought.id);
	}

	public remove(sessionId: SessionId, thought: ThoughtData): void {
		if (thought.id === undefined) return;
		const session = this._sessions.get(sessionId);
		const bucket = session?.get(thought.thought_number);
		const count = bucket?.get(thought.id);
		if (session === undefined || bucket === undefined || count === undefined) return;
		if (count > 1) {
			bucket.set(thought.id, count - 1);
		} else {
			bucket.delete(thought.id);
		}
		if (bucket.size === 0) session.delete(thought.thought_number);
		if (session.size === 0) this._sessions.delete(sessionId);
		this._removeIdentity(sessionId, thought.id);
	}

	public has(sessionId: SessionId, thoughtId: ThoughtId): boolean {
		return this._identities.get(sessionId)?.has(thoughtId) === true;
	}

	public resolve(sessionId: SessionId, thoughtNumber: number): ThoughtReferenceResolution {
		const bucket = this._sessions.get(sessionId)?.get(thoughtNumber);
		if (bucket === undefined || bucket.size === 0) return MISSING;
		if (bucket.size === 1) {
			const thoughtId = bucket.keys().next().value;
			return thoughtId === undefined ? MISSING : { kind: 'unique', thoughtId };
		}
		const thoughtIds = Object.freeze(Array.from(bucket.keys()).sort());
		return Object.freeze({ kind: 'ambiguous', thoughtIds });
	}

	public replaceSession(sessionId: SessionId, thoughts: Iterable<ThoughtData>): void {
		const replacement = new Map<number, Map<ThoughtId, number>>();
		const identities = new Map<ThoughtId, number>();
		for (const thought of thoughts) {
			this._addToSession(replacement, thought);
			if (thought.id !== undefined)
				identities.set(thought.id, (identities.get(thought.id) ?? 0) + 1);
		}
		if (replacement.size === 0) {
			this._sessions.delete(sessionId);
		} else {
			this._sessions.set(sessionId, replacement);
		}
		if (identities.size === 0) this._identities.delete(sessionId);
		else this._identities.set(sessionId, identities);
	}

	public clearSession(sessionId: SessionId): void {
		this._sessions.delete(sessionId);
		this._identities.delete(sessionId);
	}

	public clearAll(): void {
		this._sessions.clear();
		this._identities.clear();
	}

	private _addIdentity(sessionId: SessionId, thoughtId: ThoughtId): void {
		const identities = this._identities.get(sessionId) ?? new Map<ThoughtId, number>();
		identities.set(thoughtId, (identities.get(thoughtId) ?? 0) + 1);
		this._identities.set(sessionId, identities);
	}

	private _removeIdentity(sessionId: SessionId, thoughtId: ThoughtId): void {
		const identities = this._identities.get(sessionId);
		const count = identities?.get(thoughtId);
		if (identities === undefined || count === undefined) return;
		if (count > 1) identities.set(thoughtId, count - 1);
		else identities.delete(thoughtId);
		if (identities.size === 0) this._identities.delete(sessionId);
	}

	private _addToSession(session: Map<number, Map<ThoughtId, number>>, thought: ThoughtData): void {
		if (thought.id === undefined) return;
		let bucket = session.get(thought.thought_number);
		if (bucket === undefined) {
			bucket = new Map();
			session.set(thought.thought_number, bucket);
		}
		bucket.set(thought.id, (bucket.get(thought.id) ?? 0) + 1);
	}
}
