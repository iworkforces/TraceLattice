/**
 * Compile-time exhaustiveness check between `ErrorCode` and the set of
 * error codes actually used by error subclasses (or by direct
 * `SequentialThinkingError` instantiations).
 *
 * Purpose: if a new code is added to `ERROR_CODES` without a corresponding
 * subclass (or known direct usage) being added to the union below, this file
 * fails type-checking. Likewise, if a subclass code is removed from
 * `ERROR_CODES`, TypeScript flags the orphan literal.
 *
 * This file contains NO runtime tests. Vitest's `*.test-d.ts` convention
 * is used purely so the file is type-checked by the project's tsc pass
 * without being treated as a runnable test module.
 */

import type { ERROR_CODES, ErrorCode } from '../errors.js';

/**
 * Union of every error code literal currently emitted by an error subclass
 * in `src/errors.ts`, plus codes thrown directly via `SequentialThinkingError`
 * elsewhere in the codebase.
 *
 * Subclass → code mapping:
 *  - ConfigurationError        → CONFIGURATION_ERROR
 *  - ToolNotFoundError         → TOOL_NOT_FOUND
 *  - SkillNotFoundError        → SKILL_NOT_FOUND
 *  - InvalidThoughtError       → INVALID_THOUGHT
 *  - SkillDiscoveryError       → SKILL_DISCOVERY_FAILED
 *  - HistoryLimitExceededError → HISTORY_LIMIT_EXCEEDED
 *  - DuplicateSkillError       → DUPLICATE_SKILL
 *  - InvalidSkillError         → INVALID_SKILL
 *  - DuplicateToolError        → DUPLICATE_TOOL
 *  - InvalidToolError          → INVALID_TOOL
 *  - SessionNotActiveError     → SESSION_NOT_ACTIVE
 *  - SessionNotFoundError      → SESSION_NOT_FOUND
 *  - MaxSessionsReachedError   → MAX_SESSIONS_REACHED
 *  - PoolTerminatedError       → POOL_TERMINATED
 *  - ValidationError           → VALIDATION_ERROR
 *  - InvalidEdgeError          → INVALID_EDGE
 *  - CycleDetectedError        → CYCLE_DETECTED
 *  - SuspensionNotFoundError   → SUSPENSION_NOT_FOUND
 *  - SuspensionExpiredError    → SUSPENSION_EXPIRED
 *  - InvalidToolCallError      → INVALID_TOOL_CALL
 *  - InvalidBacktrackError     → INVALID_BACKTRACK
 *  - UnknownToolError          → UNKNOWN_TOOL
 *  - LockTimeoutError          → LOCK_TIMEOUT
 *  - SessionAccessDeniedError  → SESSION_ACCESS_DENIED
 *  - PersistenceOwnershipError → PERSISTENCE_OWNERSHIP
 *  - PersistenceCorruptionError → PERSISTENCE_CORRUPTION
 *  - PersistencePublicationError → PERSISTENCE_PUBLICATION
 *  - PersistenceClosedError    → PERSISTENCE_CLOSED
 *  - PersistenceDrainError     → PERSISTENCE_DRAIN
 *  - PersistenceSessionAdmissionClosedError → PERSISTENCE_SESSION_ADMISSION_CLOSED
 *  - PersistenceSessionBarrierReentrancyError → PERSISTENCE_SESSION_BARRIER_REENTRANCY
 *  - PersistenceUnavailableError → PERSISTENCE_UNAVAILABLE
 *
 * Direct `SequentialThinkingError` usages (no dedicated subclass):
 *  - DUPLICATE_SUMMARY (thrown by `core/compression/InMemorySummaryStore.ts`)
 */
type _AllSubclassCodes =
	| 'CONFIGURATION_ERROR'
	| 'TOOL_NOT_FOUND'
	| 'SKILL_NOT_FOUND'
	| 'INVALID_THOUGHT'
	| 'SKILL_DISCOVERY_FAILED'
	| 'HISTORY_LIMIT_EXCEEDED'
	| 'DUPLICATE_SKILL'
	| 'INVALID_SKILL'
	| 'DUPLICATE_TOOL'
	| 'INVALID_TOOL'
	| 'SESSION_NOT_ACTIVE'
	| 'SESSION_NOT_FOUND'
	| 'MAX_SESSIONS_REACHED'
	| 'POOL_TERMINATED'
	| 'VALIDATION_ERROR'
	| 'INVALID_EDGE'
	| 'CYCLE_DETECTED'
	| 'SUSPENSION_NOT_FOUND'
	| 'SUSPENSION_EXPIRED'
	| 'INVALID_TOOL_CALL'
	| 'INVALID_BACKTRACK'
	| 'UNKNOWN_TOOL'
	| 'LOCK_TIMEOUT'
	| 'CLI_SHUTDOWN_TIMEOUT'
	| 'SESSION_ACCESS_DENIED'
	| 'SESSION_LIFECYCLE_CLOSED'
	| 'PERSISTENCE_OWNERSHIP'
	| 'PERSISTENCE_CORRUPTION'
	| 'PERSISTENCE_PUBLICATION'
	| 'PERSISTENCE_CLOSED'
	| 'PERSISTENCE_DRAIN'
	| 'PERSISTENCE_SESSION_ADMISSION_CLOSED'
	| 'PERSISTENCE_SESSION_BARRIER_REENTRANCY'
	| 'PERSISTENCE_SCOPE_MISMATCH'
	| 'PERSISTENCE_UNAVAILABLE'
	| 'PERSISTENCE_COMPATIBILITY'
	| 'DUPLICATE_SUMMARY';

type _ErrorCodeValues = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
type _Equal<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
type _Assert<Condition extends true> = Condition;

export type ErrorCodeMatchesConstants = _Assert<_Equal<ErrorCode, _ErrorCodeValues>>;
export type ErrorCodeSetIsExhaustive = _Assert<_Equal<_AllSubclassCodes, _ErrorCodeValues>>;
