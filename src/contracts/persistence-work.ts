/**
 * Attributable work contracts for buffered persistence generations.
 *
 * @module contracts/persistence-work
 */

import type { Summary } from '../core/compression/Summary.js';
import type { Edge } from '../core/graph/Edge.js';
import type { ThoughtData } from '../core/thought.js';
import type { BranchId, SessionId, ThoughtId } from './ids.js';

/** Stable queue-assigned identity for one accepted persistence unit. */
export type PersistenceWorkToken = string;

/**
 * One accepted persistence unit.
 *
 * Every variant has an explicit named session. Snapshot variants use `key` and
 * `version` for compare-and-set acknowledgement of the exact accepted snapshot.
 */
export type PersistenceWork =
	| {
			readonly kind: 'thought';
			readonly token: PersistenceWorkToken;
			readonly sessionId: SessionId;
			readonly thought: ThoughtData;
	  }
	| {
			readonly kind: 'backtrack';
			readonly token: PersistenceWorkToken;
			readonly sessionId: SessionId;
			readonly thought: ThoughtData;
			readonly targetThoughtId: ThoughtId;
	  }
	| {
			readonly kind: 'branch';
			readonly operation: 'save';
			readonly token: PersistenceWorkToken;
			readonly sessionId: SessionId;
			readonly key: BranchId;
			readonly version: number;
			readonly snapshot: readonly ThoughtData[];
	  }
	| {
			readonly kind: 'branch';
			readonly operation: 'delete';
			readonly token: PersistenceWorkToken;
			readonly sessionId: SessionId;
			readonly key: BranchId;
			readonly version: number;
	  }
	| {
			readonly kind: 'edge';
			readonly token: PersistenceWorkToken;
			readonly sessionId: SessionId;
			readonly key: SessionId;
			readonly version: number;
			readonly snapshot: readonly Edge[];
	  }
	| {
			readonly kind: 'summary';
			readonly token: PersistenceWorkToken;
			readonly sessionId: SessionId;
			readonly key: SessionId;
			readonly version: number;
			readonly snapshot: readonly Summary[];
	  };

/**
 * Terminal failure for one accepted persistence unit.
 *
 * Snapshot failures retain their acknowledgement coordinates without exposing
 * the persisted payload. `attempts` is the exact number of backend calls made.
 */
export type PersistenceWorkFailure =
	| {
			readonly kind: 'thought';
			readonly token: PersistenceWorkToken;
			readonly sessionId: SessionId;
			readonly attempts: number;
			readonly cause: unknown;
	  }
	| {
			readonly kind: 'backtrack';
			readonly token: PersistenceWorkToken;
			readonly sessionId: SessionId;
			readonly attempts: number;
			readonly cause: unknown;
	  }
	| {
			readonly kind: 'branch';
			readonly operation: 'save' | 'delete';
			readonly token: PersistenceWorkToken;
			readonly sessionId: SessionId;
			readonly key: BranchId;
			readonly version: number;
			readonly attempts: number;
			readonly cause: unknown;
	  }
	| {
			readonly kind: 'edge';
			readonly token: PersistenceWorkToken;
			readonly sessionId: SessionId;
			readonly key: SessionId;
			readonly version: number;
			readonly attempts: number;
			readonly cause: unknown;
	  }
	| {
			readonly kind: 'summary';
			readonly token: PersistenceWorkToken;
			readonly sessionId: SessionId;
			readonly key: SessionId;
			readonly version: number;
			readonly attempts: number;
			readonly cause: unknown;
	  };

/** Immutable outcome captured when a persistence generation settles. */
export type PersistenceGenerationResult = {
	readonly failures: readonly PersistenceWorkFailure[];
};
