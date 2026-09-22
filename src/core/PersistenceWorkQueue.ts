/**
 * Pure attributable queue for accepted persistence work.
 *
 * @module core/PersistenceWorkQueue
 */

// allow: SIZE_OK - Task 8 requires this single-responsibility queue in exactly one production file.

import type {
	PersistenceGenerationResult,
	PersistenceWork,
	PersistenceWorkFailure,
	PersistenceWorkToken,
} from '../contracts/persistence-work.js';
import type { BranchId, SessionId, ThoughtId } from '../contracts/ids.js';
import { assertNever } from '../utils.js';
import type { Summary } from './compression/Summary.js';
import {
	DurableThoughtIdentityIndex,
	type DurableIdentitySession,
	normalizeDurableHistoryRetention,
} from './DurableThoughtIdentityIndex.js';
import type { Edge } from './graph/Edge.js';
import type { ThoughtData } from './thought.js';

/** Selects whether retained terminal failures are eligible for a generation. */
export type PersistenceSelectionMode = 'explicit' | 'background';

type WorkKind = PersistenceWork['kind'];
type WorkOf<K extends WorkKind> = Extract<PersistenceWork, { readonly kind: K }>;

type QueueEntry<K extends WorkKind> = {
	readonly acceptedSequence: number;
	readonly work: WorkOf<K>;
	terminalFailure: PersistenceWorkFailure | undefined;
};

type ThoughtEntry = QueueEntry<'thought'>;
type BacktrackEntry = QueueEntry<'backtrack'>;
type BranchEntry = QueueEntry<'branch'>;
type EdgeEntry = QueueEntry<'edge'>;
type SummaryEntry = QueueEntry<'summary'>;
type AnyQueueEntry = ThoughtEntry | BacktrackEntry | BranchEntry | EdgeEntry | SummaryEntry;

type Acceptance = {
	readonly token: PersistenceWorkToken;
	readonly sequence: number;
};

/**
 * Stores accepted persistence work independently from live session state.
 *
 * Thought entries retain FIFO acceptance order. Auxiliary snapshots coalesce at
 * their stable coordinate and use versioned compare-and-set acknowledgement.
 * Generation state remains caller-owned in a `Set` passed to selection methods.
 *
 * @example
 * ```ts
 * const queue = new PersistenceWorkQueue();
 * queue.enqueueThought(sessionId, thought);
 * const selected = new Set<PersistenceWorkToken>();
 * const work = queue.nextEligibleWork(selected, 'explicit');
 * if (work !== undefined) queue.acknowledgeSuccess(work);
 * ```
 */
export class PersistenceWorkQueue {
	private readonly _thoughts: Array<ThoughtEntry | BacktrackEntry> = [];
	private readonly _thoughtIdentities = new Map<SessionId, Map<ThoughtId, number>>();
	private readonly _durableThoughtIdentities: DurableThoughtIdentityIndex;
	private readonly _persistBranches: boolean;
	private readonly _branches = new Map<SessionId, Map<BranchId, BranchEntry>>();
	private readonly _edges = new Map<SessionId, EdgeEntry>();
	private readonly _summaries = new Map<SessionId, SummaryEntry>();

	private readonly _branchVersions = new Map<SessionId, Map<BranchId, number>>();
	private readonly _edgeVersions = new Map<SessionId, number>();
	private readonly _summaryVersions = new Map<SessionId, number>();
	private _nextSequence = 1;

	public constructor(durableHistorySize = 10_000, persistBranches = true) {
		this._durableThoughtIdentities = new DurableThoughtIdentityIndex(
			normalizeDurableHistoryRetention(durableHistorySize)
		);
		this._persistBranches = persistBranches;
	}

	/**
	 * Accepts one thought as a distinct FIFO work item.
	 *
	 * @param sessionId - Session that owns the thought write.
	 * @param thought - Thought payload accepted by the coordinator.
	 * @returns The exact immutable work handle used for acknowledgement.
	 */
	public enqueueThought(sessionId: SessionId, thought: ThoughtData): WorkOf<'thought'> {
		const acceptance = this._accept();
		const work: WorkOf<'thought'> = Object.freeze({
			kind: 'thought',
			token: acceptance.token,
			sessionId,
			thought: this._freezeClone(thought),
		});
		this._thoughts.push({
			acceptedSequence: acceptance.sequence,
			work,
			terminalFailure: undefined,
		});
		if (thought.id !== undefined) this._addThoughtIdentity(sessionId, thought.id);
		return work;
	}

	public enqueueBacktrack(
		sessionId: SessionId,
		thought: ThoughtData,
		targetThoughtId: ThoughtId
	): WorkOf<'backtrack'> {
		const acceptance = this._accept();
		const work: WorkOf<'backtrack'> = Object.freeze({
			kind: 'backtrack',
			token: acceptance.token,
			sessionId,
			thought: this._freezeClone(thought),
			targetThoughtId,
		});
		this._thoughts.push({
			acceptedSequence: acceptance.sequence,
			work,
			terminalFailure: undefined,
		});
		if (thought.id !== undefined) this._addThoughtIdentity(sessionId, thought.id);
		return work;
	}

	public hasThoughtIdentity(sessionId: SessionId, thoughtId: ThoughtId): boolean {
		return (
			this._thoughtIdentities.get(sessionId)?.has(thoughtId) === true ||
			this._durableThoughtIdentities.has(sessionId, thoughtId)
		);
	}

	public replaceDurableThoughtIdentities(sessions: readonly DurableIdentitySession[]): void {
		this._durableThoughtIdentities.replaceAll(sessions);
	}

	/**
	 * Replaces the pending snapshot for one session-owned branch.
	 *
	 * @param sessionId - Session that owns the branch.
	 * @param branchId - Stable branch coordinate within the session.
	 * @param thoughts - Branch snapshot; its array is copied before storage.
	 * @returns The new immutable, versioned work handle.
	 */
	public replaceBranch(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): WorkOf<'branch'> {
		const versionMap = this._branchVersions.get(sessionId) ?? new Map<BranchId, number>();
		this._branchVersions.set(sessionId, versionMap);
		const version = (versionMap.get(branchId) ?? 0) + 1;
		versionMap.set(branchId, version);

		const acceptance = this._accept();
		const work: WorkOf<'branch'> = Object.freeze({
			kind: 'branch',
			operation: 'save',
			token: acceptance.token,
			sessionId,
			key: branchId,
			version,
			snapshot: this._freezeClone(thoughts),
		});
		const branchMap = this._branches.get(sessionId) ?? new Map<BranchId, BranchEntry>();
		this._branches.set(sessionId, branchMap);
		branchMap.set(branchId, {
			acceptedSequence: acceptance.sequence,
			work,
			terminalFailure: undefined,
		});
		return work;
	}

	/**
	 * @param sessionId - Session that owns the branch.
	 * @param branchId - Stable branch coordinate within the session.
	 * @returns The new immutable, versioned deletion work handle.
	 */
	public deleteBranch(sessionId: SessionId, branchId: BranchId): WorkOf<'branch'> {
		const versionMap = this._branchVersions.get(sessionId) ?? new Map<BranchId, number>();
		this._branchVersions.set(sessionId, versionMap);
		const version = (versionMap.get(branchId) ?? 0) + 1;
		versionMap.set(branchId, version);

		const acceptance = this._accept();
		const work: WorkOf<'branch'> = Object.freeze({
			kind: 'branch',
			operation: 'delete',
			token: acceptance.token,
			sessionId,
			key: branchId,
			version,
		});
		const branchMap = this._branches.get(sessionId) ?? new Map<BranchId, BranchEntry>();
		this._branches.set(sessionId, branchMap);
		branchMap.set(branchId, {
			acceptedSequence: acceptance.sequence,
			work,
			terminalFailure: undefined,
		});
		return work;
	}

	/**
	 * Replaces the pending edge snapshot for a session.
	 *
	 * @param sessionId - Stable session coordinate for the edge set.
	 * @param edges - Edge snapshot; its array is copied before storage.
	 * @returns The new immutable, versioned work handle.
	 */
	public replaceEdges(sessionId: SessionId, edges: readonly Edge[]): WorkOf<'edge'> {
		const version = (this._edgeVersions.get(sessionId) ?? 0) + 1;
		this._edgeVersions.set(sessionId, version);
		const acceptance = this._accept();
		const work: WorkOf<'edge'> = Object.freeze({
			kind: 'edge',
			token: acceptance.token,
			sessionId,
			key: sessionId,
			version,
			snapshot: this._freezeClone(edges),
		});
		this._edges.set(sessionId, {
			acceptedSequence: acceptance.sequence,
			work,
			terminalFailure: undefined,
		});
		return work;
	}

	/**
	 * Replaces the pending summary snapshot for a session.
	 *
	 * @param sessionId - Stable session coordinate for the summary set.
	 * @param summaries - Summary snapshot; its array is copied before storage.
	 * @returns The new immutable, versioned work handle.
	 */
	public replaceSummaries(sessionId: SessionId, summaries: readonly Summary[]): WorkOf<'summary'> {
		const version = (this._summaryVersions.get(sessionId) ?? 0) + 1;
		this._summaryVersions.set(sessionId, version);
		const acceptance = this._accept();
		const work: WorkOf<'summary'> = Object.freeze({
			kind: 'summary',
			token: acceptance.token,
			sessionId,
			key: sessionId,
			version,
			snapshot: this._freezeClone(summaries),
		});
		this._summaries.set(sessionId, {
			acceptedSequence: acceptance.sequence,
			work,
			terminalFailure: undefined,
		});
		return work;
	}

	/**
	 * Reports whether a generation can select current work.
	 *
	 * @param selectedTokens - Tokens already selected by the caller's generation.
	 * @param mode - Explicit generations re-arm failures; background generations skip them.
	 * @param sessionId - Optional session projection.
	 * @returns `true` when at least one current entry is eligible.
	 */
	public hasEligibleWork(
		selectedTokens: ReadonlySet<PersistenceWorkToken>,
		mode: PersistenceSelectionMode,
		sessionId?: SessionId
	): boolean {
		return this._findEligible(selectedTokens, mode, sessionId) !== undefined;
	}

	/**
	 * Selects the oldest currently eligible work and records it in the generation set.
	 *
	 * @param selectedTokens - Mutable set owned by the caller's generation.
	 * @param mode - Explicit generations re-arm failures; background generations skip them.
	 * @param sessionId - Optional session projection.
	 * @returns The selected work, or `undefined` when no current entry is eligible.
	 */
	public nextEligibleWork(
		selectedTokens: Set<PersistenceWorkToken>,
		mode: PersistenceSelectionMode,
		sessionId?: SessionId
	): PersistenceWork | undefined {
		const entry = this._findEligible(selectedTokens, mode, sessionId);
		if (entry === undefined) return undefined;
		selectedTokens.add(entry.work.token);
		return entry.work;
	}

	/**
	 * Acknowledges successful persistence using exact token/version CAS semantics.
	 *
	 * @param work - Previously selected work handle.
	 */
	public acknowledgeSuccess(work: PersistenceWork): void {
		const entry = this._currentEntry(work);
		if (entry === undefined) return;
		switch (work.kind) {
			case 'thought': {
				const index = this._thoughts.findIndex((candidate) => candidate === entry);
				if (index >= 0) {
					this._thoughts.splice(index, 1);
					if (work.thought.id !== undefined) {
						this._removeThoughtIdentity(work.sessionId, work.thought.id);
					}
					this._durableThoughtIdentities.appendThought(work.sessionId, work.thought);
				}
				return;
			}
			case 'backtrack': {
				const index = this._thoughts.findIndex((candidate) => candidate === entry);
				if (index >= 0) {
					this._thoughts.splice(index, 1);
					if (work.thought.id !== undefined) {
						this._removeThoughtIdentity(work.sessionId, work.thought.id);
					}
					this._durableThoughtIdentities.appendThought(work.sessionId, work.thought);
				}
				return;
			}
			case 'branch':
				this._branches.get(work.sessionId)?.delete(work.key);
				if (!this._persistBranches) return;
				if (work.operation === 'save') {
					this._durableThoughtIdentities.replaceBranch(work.sessionId, work.key, work.snapshot);
				} else {
					this._durableThoughtIdentities.deleteBranch(work.sessionId, work.key);
				}
				return;
			case 'edge':
				this._edges.delete(work.key);
				return;
			case 'summary':
				this._summaries.delete(work.key);
				return;
			default:
				assertNever(work);
		}
	}

	/**
	 * Attaches a terminal failure only when both work and failure still match current work.
	 *
	 * @param work - Previously selected work handle.
	 * @param failure - Terminal backend failure attributed to that handle.
	 */
	public acknowledgeFailure(work: PersistenceWork, failure: PersistenceWorkFailure): void {
		if (!this._matchesFailure(work, failure)) return;
		const entry = this._currentEntry(work);
		if (entry !== undefined) entry.terminalFailure = Object.freeze({ ...failure });
	}

	/**
	 * Returns an immutable acceptance-ordered snapshot of current terminal failures.
	 *
	 * @param selectedTokens - Optional generation-token projection.
	 * @param sessionId - Optional session projection.
	 * @returns A fresh readonly failure array containing only failures on current entries.
	 */
	public currentFailures(
		selectedTokens?: ReadonlySet<PersistenceWorkToken>,
		sessionId?: SessionId
	): readonly PersistenceWorkFailure[] {
		const failures = this._entries()
			.filter(
				(entry) =>
					entry.terminalFailure !== undefined &&
					(selectedTokens === undefined || selectedTokens.has(entry.work.token)) &&
					(sessionId === undefined || entry.work.sessionId === sessionId)
			)
			.sort((left, right) => left.acceptedSequence - right.acceptedSequence)
			.flatMap((entry) => (entry.terminalFailure === undefined ? [] : [entry.terminalFailure]));
		return Object.freeze(failures);
	}

	/**
	 * Captures the current immutable result for a generation or session projection.
	 *
	 * @param selectedTokens - Optional generation-token projection.
	 * @param sessionId - Optional session projection.
	 * @returns A result containing a fresh readonly failure snapshot.
	 */
	public generationResult(
		selectedTokens?: ReadonlySet<PersistenceWorkToken>,
		sessionId?: SessionId
	): PersistenceGenerationResult {
		return Object.freeze({ failures: this.currentFailures(selectedTokens, sessionId) });
	}

	/** @returns Number of accepted thought writes not yet acknowledged successful. */
	public get pendingThoughtCount(): number {
		return this._thoughts.length;
	}

	/** @returns Number of all current thought and coalesced auxiliary entries. */
	public get pendingWorkCount(): number {
		let branchCount = 0;
		for (const branches of this._branches.values()) branchCount += branches.size;
		return this._thoughts.length + branchCount + this._edges.size + this._summaries.size;
	}

	/** @returns Whether any accepted work remains for a session across all work kinds. */
	public hasSessionWork(sessionId: SessionId): boolean {
		return this._entries().some((entry) => entry.work.sessionId === sessionId);
	}

	/** @returns Whether current retained work for a session owns a terminal failure. */
	public hasSessionTerminalFailure(sessionId: SessionId): boolean {
		return this.currentFailures(undefined, sessionId).length > 0;
	}

	/**
	 * Forgets version coordinates only after all accepted work for a session is gone.
	 *
	 * @returns `false` without mutation while any accepted work remains.
	 */
	public forgetQuiescentSession(sessionId: SessionId): boolean {
		if (this.hasSessionWork(sessionId)) return false;
		this._branches.delete(sessionId);
		this._branchVersions.delete(sessionId);
		this._edgeVersions.delete(sessionId);
		this._summaryVersions.delete(sessionId);
		return true;
	}

	/** Discards every retained work item and version coordinate for one deleted session. */
	public discardSession(sessionId: SessionId): void {
		for (let index = this._thoughts.length - 1; index >= 0; index -= 1) {
			if (this._thoughts[index]?.work.sessionId === sessionId) this._thoughts.splice(index, 1);
		}
		this._thoughtIdentities.delete(sessionId);
		this._durableThoughtIdentities.clearSession(sessionId);
		this._branches.delete(sessionId);
		this._edges.delete(sessionId);
		this._summaries.delete(sessionId);
		this._branchVersions.delete(sessionId);
		this._edgeVersions.delete(sessionId);
		this._summaryVersions.delete(sessionId);
	}

	/** Discards all retained work after a successful durable global reset. */
	public discardAll(): void {
		this._thoughts.length = 0;
		this._thoughtIdentities.clear();
		this._durableThoughtIdentities.clearAll();
		this._branches.clear();
		this._edges.clear();
		this._summaries.clear();
		this._branchVersions.clear();
		this._edgeVersions.clear();
		this._summaryVersions.clear();
	}

	private _accept(): Acceptance {
		const sequence = this._nextSequence;
		this._nextSequence += 1;
		return { token: `persistence-work-${sequence}`, sequence };
	}

	private _freezeClone<T>(value: T): T {
		const clone = structuredClone(value);
		return this._deepFreeze(clone);
	}

	private _deepFreeze<T>(value: T): T {
		if (value !== null && typeof value === 'object') {
			for (const nested of Object.values(value)) this._deepFreeze(nested);
			Object.freeze(value);
		}
		return value;
	}

	private _addThoughtIdentity(sessionId: SessionId, thoughtId: ThoughtId): void {
		const identities = this._thoughtIdentities.get(sessionId) ?? new Map<ThoughtId, number>();
		identities.set(thoughtId, (identities.get(thoughtId) ?? 0) + 1);
		this._thoughtIdentities.set(sessionId, identities);
	}

	private _removeThoughtIdentity(sessionId: SessionId, thoughtId: ThoughtId): void {
		const identities = this._thoughtIdentities.get(sessionId);
		const count = identities?.get(thoughtId);
		if (identities === undefined || count === undefined) return;
		if (count > 1) identities.set(thoughtId, count - 1);
		else identities.delete(thoughtId);
		if (identities.size === 0) this._thoughtIdentities.delete(sessionId);
	}

	private _entries(): AnyQueueEntry[] {
		const entries: AnyQueueEntry[] = [...this._thoughts];
		for (const branches of this._branches.values()) entries.push(...branches.values());
		entries.push(...this._edges.values(), ...this._summaries.values());
		return entries;
	}

	private _findEligible(
		selectedTokens: ReadonlySet<PersistenceWorkToken>,
		mode: PersistenceSelectionMode,
		sessionId?: SessionId
	): AnyQueueEntry | undefined {
		let oldest: AnyQueueEntry | undefined;
		for (const entry of this._entries()) {
			if (selectedTokens.has(entry.work.token)) continue;
			if (sessionId !== undefined && entry.work.sessionId !== sessionId) continue;
			if (!this._modeAllows(mode, entry.terminalFailure !== undefined)) continue;
			if (oldest === undefined || entry.acceptedSequence < oldest.acceptedSequence) oldest = entry;
		}
		return oldest;
	}

	private _modeAllows(mode: PersistenceSelectionMode, hasTerminalFailure: boolean): boolean {
		switch (mode) {
			case 'explicit':
				return true;
			case 'background':
				return !hasTerminalFailure;
			default:
				return assertNever(mode);
		}
	}

	private _currentEntry(work: PersistenceWork): AnyQueueEntry | undefined {
		let entry: AnyQueueEntry | undefined;
		switch (work.kind) {
			case 'thought':
			case 'backtrack':
				entry = this._thoughts.find((candidate) => candidate.work.token === work.token);
				break;
			case 'branch':
				entry = this._branches.get(work.sessionId)?.get(work.key);
				break;
			case 'edge':
				entry = this._edges.get(work.key);
				break;
			case 'summary':
				entry = this._summaries.get(work.key);
				break;
			default:
				return assertNever(work);
		}
		return entry !== undefined && this._matchesWork(entry.work, work) ? entry : undefined;
	}

	private _matchesWork(current: PersistenceWork, selected: PersistenceWork): boolean {
		if (
			current.kind !== selected.kind ||
			current.token !== selected.token ||
			current.sessionId !== selected.sessionId
		) {
			return false;
		}
		switch (selected.kind) {
			case 'thought':
				return current.kind === 'thought';
			case 'backtrack':
				return current.kind === 'backtrack' && current.targetThoughtId === selected.targetThoughtId;
			case 'branch':
				return (
					current.kind === 'branch' &&
					current.operation === selected.operation &&
					current.key === selected.key &&
					current.version === selected.version
				);
			case 'edge':
				return (
					current.kind === 'edge' &&
					current.key === selected.key &&
					current.version === selected.version
				);
			case 'summary':
				return (
					current.kind === 'summary' &&
					current.key === selected.key &&
					current.version === selected.version
				);
			default:
				return assertNever(selected);
		}
	}

	private _matchesFailure(work: PersistenceWork, failure: PersistenceWorkFailure): boolean {
		if (
			work.kind !== failure.kind ||
			work.token !== failure.token ||
			work.sessionId !== failure.sessionId
		) {
			return false;
		}
		switch (work.kind) {
			case 'thought':
			case 'backtrack':
				return true;
			case 'branch':
				return (
					failure.kind === 'branch' &&
					work.operation === failure.operation &&
					work.key === failure.key &&
					work.version === failure.version
				);
			case 'edge':
			case 'summary':
				return 'key' in failure && work.key === failure.key && work.version === failure.version;
			default:
				return assertNever(work);
		}
	}
}
