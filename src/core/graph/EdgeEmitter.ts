/**
 * EdgeEmitter — emits DAG edges for thoughts based on their metadata.
 *
 * Stateless helper extracted from HistoryManager. Holds a reference to an
 * optional `IEdgeStore` and a feature flag (`dagEdges`) gating writes.
 *
 * @module EdgeEmitter
 */

import type { IEdgeStore } from '../../contracts/interfaces.js';
import { getErrorMessage } from '../../errors.js';
import type { Logger } from '../../logger/StructuredLogger.js';
import { NullLogger } from '../../logger/NullLogger.js';
import type { ThoughtData } from '../thought.js';
import type { ResolvedThoughtReferences, ThoughtAdmissionContext } from '../IHistoryManager.js';
import { resolvedVerificationTarget } from '../evaluator/VerificationLinks.js';
import type { Edge, EdgeKind } from './Edge.js';
import {
	generateEdgeId,
	type BranchId,
	type SessionId,
	type ThoughtId,
} from '../../contracts/ids.js';

/** Minimal session view needed for edge emission. */
export interface EdgeEmissionSession {
	thought_history: ThoughtData[];
	branches: Record<BranchId, ThoughtData[]>;
}

/** Configuration options for EdgeEmitter. */
export interface EdgeEmitterConfig {
	edgeStore?: IEdgeStore;
	dagEdges: boolean;
	logger?: Logger;
}

/**
 * Emits DAG edges for thought relationships when an `IEdgeStore` is configured
 * and the `dagEdges` feature flag is enabled. No-ops otherwise.
 */
export class EdgeEmitter {
	private readonly _edgeStore?: IEdgeStore;
	private readonly _dagEdges: boolean;
	private readonly _logger: Logger;

	constructor(config: EdgeEmitterConfig) {
		this._edgeStore = config.edgeStore;
		this._dagEdges = config.dagEdges;
		this._logger = config.logger ?? new NullLogger();
	}

	/** Returns true when edge emission is active (store + flag both set). */
	public isEnabled(): boolean {
		return this._edgeStore !== undefined && this._dagEdges;
	}

	/**
	 * Emits DAG edges for a thought based on its metadata fields.
	 *
	 * Edge kinds (in priority order):
	 * - branch: branch_from_thought + branch_id → parent.id → current.id
	 * - merge: merge_from_thoughts → source.id → current.id (per source)
	 * - verifies: verification_target + thought_type=verification → current.id → target.id
	 * - critiques: verification_target + thought_type=critique → current.id → target.id
	 * - derives_from: synthesis_sources → source.id → current.id (per source)
	 * - revises: revises_thought → current.id → target.id
	 * - tool_invocation: stable admission source id → current.id
	 * - sequence: default chronological link from previous thought (if none of the above)
	 * @returns True only when at least one edge was added to the store
	 */
	public emitEdgesForThought(
		session: EdgeEmissionSession,
		thought: ThoughtData,
		context?: ThoughtAdmissionContext
	): boolean {
		if (!this._edgeStore || !this._dagEdges) return false;
		if (!thought.id) return false;

		const sessionId = thought.session_id;
		const references = context?.resolvedReferences ?? {};
		const hasRelationalIntent =
			(thought.branch_from_thought !== undefined && thought.branch_id !== undefined) ||
			(thought.merge_from_thoughts?.length ?? 0) > 0 ||
			(thought.verification_target !== undefined &&
				(thought.thought_type === 'verification' || thought.thought_type === 'critique')) ||
			(thought.synthesis_sources?.length ?? 0) > 0 ||
			thought.revises_thought !== undefined ||
			(thought.thought_type === 'tool_observation' &&
				context?.toolInvocationSourceThoughtId !== undefined);
		const emittedRelational = [
			this._emitBranchEdge(thought, references, sessionId),
			this._emitMergeEdges(thought, references, sessionId),
			this._emitVerificationEdge(thought, references, sessionId),
			this._emitCritiqueEdge(thought, references, sessionId),
			this._emitSynthesisEdges(thought, references, sessionId),
			this._emitRevisionEdge(thought, references, sessionId),
			this._emitToolInvocationEdge(thought, sessionId, context),
		].some((emitted) => emitted);

		if (emittedRelational || hasRelationalIntent) return emittedRelational;
		return this._emitSequenceEdge(session, thought, sessionId);
	}

	private _emitBranchEdge(
		thought: ThoughtData,
		references: ResolvedThoughtReferences,
		sessionId: SessionId
	): boolean {
		if (thought.branch_from_thought === undefined || !thought.branch_id) return false;

		return this._addEdgeIfValid(references.branchFromThoughtId, thought.id, 'branch', sessionId);
	}

	private _emitMergeEdges(
		thought: ThoughtData,
		references: ResolvedThoughtReferences,
		sessionId: SessionId
	): boolean {
		let emitted = false;
		for (const srcId of references.mergeFromThoughtIds ?? []) {
			emitted = this._addEdgeIfValid(srcId, thought.id, 'merge', sessionId) || emitted;
		}
		return emitted;
	}

	private _emitVerificationEdge(
		thought: ThoughtData,
		references: ResolvedThoughtReferences,
		sessionId: SessionId
	): boolean {
		if (thought.verification_target === undefined || thought.thought_type !== 'verification')
			return false;

		return this._addEdgeIfValid(
			thought.id,
			resolvedVerificationTarget(thought, references),
			'verifies',
			sessionId
		);
	}

	private _emitCritiqueEdge(
		thought: ThoughtData,
		references: ResolvedThoughtReferences,
		sessionId: SessionId
	): boolean {
		if (thought.verification_target === undefined || thought.thought_type !== 'critique')
			return false;

		return this._addEdgeIfValid(
			thought.id,
			references.verificationTargetThoughtId,
			'critiques',
			sessionId
		);
	}

	private _emitSynthesisEdges(
		thought: ThoughtData,
		references: ResolvedThoughtReferences,
		sessionId: SessionId
	): boolean {
		let emitted = false;
		for (const srcId of references.synthesisSourceThoughtIds ?? []) {
			emitted = this._addEdgeIfValid(srcId, thought.id, 'derives_from', sessionId) || emitted;
		}
		return emitted;
	}

	private _emitRevisionEdge(
		thought: ThoughtData,
		references: ResolvedThoughtReferences,
		sessionId: SessionId
	): boolean {
		if (thought.revises_thought === undefined) return false;

		return this._addEdgeIfValid(thought.id, references.revisesThoughtId, 'revises', sessionId);
	}

	private _emitToolInvocationEdge(
		thought: ThoughtData,
		sessionId: SessionId,
		context?: ThoughtAdmissionContext
	): boolean {
		if (
			thought.thought_type !== 'tool_observation' ||
			context?.toolInvocationSourceThoughtId === undefined
		) {
			return false;
		}

		const metadata = thought.tool_name !== undefined ? { tool_name: thought.tool_name } : undefined;
		return this._addEdgeIfValid(
			context.toolInvocationSourceThoughtId,
			thought.id,
			'tool_invocation',
			sessionId,
			metadata
		);
	}

	private _emitSequenceEdge(
		session: EdgeEmissionSession,
		thought: ThoughtData,
		sessionId: SessionId
	): boolean {
		const history = session.thought_history;
		if (history.length < 2) return false;

		const prev = history[history.length - 2];
		if (!prev?.id) return false;

		return this._addEdgeIfValid(prev.id, thought.id, 'sequence', sessionId);
	}

	/**
	 * Adds an edge to the edge store if both endpoints are non-empty strings.
	 * Returns true if added, false if skipped (missing endpoint).
	 * Failures (e.g. self-edge) are caught and logged.
	 */
	private _addEdgeIfValid(
		from: ThoughtId | undefined,
		to: ThoughtId | undefined,
		kind: EdgeKind,
		sessionId: SessionId,
		metadata?: Record<string, unknown>
	): boolean {
		if (!from || !to) {
			this._logger.debug('Skipping edge: unresolved endpoint', {
				kind,
				from: from ?? null,
				to: to ?? null,
			});
			return false;
		}
		const edge: Edge = {
			id: generateEdgeId(),
			from: from as Edge['from'],
			to: to as Edge['to'],
			kind,
			sessionId: sessionId as Edge['sessionId'],
			createdAt: Date.now(),
			...(metadata !== undefined ? { metadata } : {}),
		};
		if (!this._edgeStore) {
			this._logger.warn('EdgeStore not available; skipping edge', { kind });
			return false;
		}
		const duplicate = this._edgeStore
			.edgesForSession(sessionId)
			.some((existing) => existing.kind === kind && existing.from === from && existing.to === to);
		if (duplicate) return false;
		try {
			this._edgeStore.addEdge(edge);
			return true;
		} catch (err) {
			this._logger.info('Failed to add DAG edge', {
				kind,
				error: getErrorMessage(err),
			});
			return false;
		}
	}
}
