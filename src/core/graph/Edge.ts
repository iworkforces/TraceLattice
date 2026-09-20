/**
 * Edge type definitions for the thought DAG.
 *
 * Edges represent semantic relationships between thoughts. Endpoints reference
 * `thought.id` (ulid string) rather than `thought_number` to avoid ambiguity
 * across branches.
 *
 * @module core/graph/Edge
 */

import type { EdgeId, SessionId, ThoughtId } from '../../contracts/ids.js';

/**
 * Kinds of relationships between thoughts in the DAG.
 *
 * Each kind represents a semantic relationship that the reasoning controller
 * can use for search policy decisions.
 *
 * NOTE: Kept as a hand-written union (not inferred from `EdgeKindSchema`) because
 * `schema.ts` imports `EdgeKind` from this file to constrain the schema via
 * `satisfies v.GenericSchema<EdgeKind>`. Reversing the dependency would create a
 * circular import (schema.ts → Edge.ts → schema.ts). The `satisfies` clause in
 * schema.ts already guarantees the schema and the union stay in sync.
 */
export type EdgeKind =
	| 'sequence' // default chronological successor
	| 'branch' // thought branched from a parent
	| 'merge' // thought merged insights from multiple sources
	| 'verifies' // thought verifies a hypothesis
	| 'critiques' // thought critiques a hypothesis
	| 'derives_from' // thought synthesizes from multiple sources
	| 'tool_invocation' // tool_call → tool_observation link
	| 'revises'; // thought revises a prior thought

/**
 * A directed edge in the thought DAG.
 *
 * Endpoints use `thought.id` (ulid string), not `thought_number`,
 * to avoid ambiguity under branching.
 *
 * @example
 * ```typescript
 * const edge: Edge = {
 *   id: generateUlid(),
 *   from: parentThought.id,
 *   to: childThought.id,
 *   kind: 'sequence',
 *   sessionId: asSessionId('analysis-session'),
 *   createdAt: Date.now(),
 * };
 * ```
 */
export interface Edge {
	/** Unique edge identifier (ulid). */
	readonly id: EdgeId;
	/** Source thought id. */
	readonly from: ThoughtId;
	/** Target thought id. */
	readonly to: ThoughtId;
	/** Semantic relationship kind. */
	readonly kind: EdgeKind;
	/** Session this edge belongs to. */
	readonly sessionId: SessionId;
	/** Creation timestamp (`Date.now()`). */
	readonly createdAt: number;
	/** Optional metadata for strategy-specific annotations. */
	readonly metadata?: Record<string, unknown>;
}
