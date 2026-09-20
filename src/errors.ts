/**
 * Custom error types for the TraceLattice server.
 *
 * This module defines a hierarchy of error classes for handling various
 * error conditions that can occur in the sequential thinking server.
 * All errors extend the base `SequentialThinkingError` class with
 * specific error codes for programmatic handling.
 *
 * @example
 * ```typescript
 * import { ToolNotFoundError, SkillDiscoveryError } from './errors.js';
 *
 * // Throw a tool not found error
 * throw new ToolNotFoundError('my-tool');
 *
 * // Catch and handle specific errors
 * try {
 *   await discoverSkills(dir);
 * } catch (error) {
 *   if (error instanceof SkillDiscoveryError) {
 *     console.error(`Failed to discover skills: ${error.message}`);
 *     console.error(`Error code: ${error.code}`);
 *   }
 * }
 * ```
 * @module errors
 */

/**
 * All known error codes as a const object for exhaustive switching.
 */
export const ERROR_CODES = {
	CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
	TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
	SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
	INVALID_THOUGHT: 'INVALID_THOUGHT',
	SKILL_DISCOVERY_FAILED: 'SKILL_DISCOVERY_FAILED',
	HISTORY_LIMIT_EXCEEDED: 'HISTORY_LIMIT_EXCEEDED',
	DUPLICATE_SKILL: 'DUPLICATE_SKILL',
	INVALID_SKILL: 'INVALID_SKILL',
	DUPLICATE_TOOL: 'DUPLICATE_TOOL',
	INVALID_TOOL: 'INVALID_TOOL',
	SESSION_NOT_ACTIVE: 'SESSION_NOT_ACTIVE',
	SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
	MAX_SESSIONS_REACHED: 'MAX_SESSIONS_REACHED',
	POOL_TERMINATED: 'POOL_TERMINATED',
	VALIDATION_ERROR: 'VALIDATION_ERROR',
	INVALID_EDGE: 'INVALID_EDGE',
	CYCLE_DETECTED: 'CYCLE_DETECTED',
	SUSPENSION_NOT_FOUND: 'SUSPENSION_NOT_FOUND',
	SUSPENSION_EXPIRED: 'SUSPENSION_EXPIRED',
	INVALID_TOOL_CALL: 'INVALID_TOOL_CALL',
	INVALID_BACKTRACK: 'INVALID_BACKTRACK',
	DUPLICATE_SUMMARY: 'DUPLICATE_SUMMARY',
	UNKNOWN_TOOL: 'UNKNOWN_TOOL',
	LOCK_TIMEOUT: 'LOCK_TIMEOUT',
	CLI_SHUTDOWN_TIMEOUT: 'CLI_SHUTDOWN_TIMEOUT',
	SESSION_ACCESS_DENIED: 'SESSION_ACCESS_DENIED',
	SESSION_LIFECYCLE_CLOSED: 'SESSION_LIFECYCLE_CLOSED',
	PERSISTENCE_OWNERSHIP: 'PERSISTENCE_OWNERSHIP',
	PERSISTENCE_CORRUPTION: 'PERSISTENCE_CORRUPTION',
	PERSISTENCE_PUBLICATION: 'PERSISTENCE_PUBLICATION',
	PERSISTENCE_CLOSED: 'PERSISTENCE_CLOSED',
	PERSISTENCE_DRAIN: 'PERSISTENCE_DRAIN',
	PERSISTENCE_SESSION_ADMISSION_CLOSED: 'PERSISTENCE_SESSION_ADMISSION_CLOSED',
	PERSISTENCE_SESSION_BARRIER_REENTRANCY: 'PERSISTENCE_SESSION_BARRIER_REENTRANCY',
	PERSISTENCE_SCOPE_MISMATCH: 'PERSISTENCE_SCOPE_MISMATCH',
	PERSISTENCE_UNAVAILABLE: 'PERSISTENCE_UNAVAILABLE',
	PERSISTENCE_COMPATIBILITY: 'PERSISTENCE_COMPATIBILITY',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * All known warning codes as a const object.
 * Warnings are non-fatal advisory signals returned alongside successful results.
 */
export const WARNING_CODES = {
	TOTAL_THOUGHTS_ADJUSTED: 'TOTAL_THOUGHTS_ADJUSTED',
} as const;

export type WarningCode = (typeof WARNING_CODES)[keyof typeof WARNING_CODES];

/**
 * Base error class for all Sequential Thinking server errors.
 *
 * This error extends the native `Error` class and adds a `code` property
 * for programmatic error identification and handling. All specific error
 * types in the system extend this base class.
 *
 * @remarks
 * **Error Codes:**
 * - `TOOL_NOT_FOUND` - A requested tool was not found
 * - `SKILL_NOT_FOUND` - A requested skill was not found
 * - `INVALID_THOUGHT` - Thought validation failed
 * - `SKILL_DISCOVERY_FAILED` - Skill discovery operation failed
 * - `HISTORY_LIMIT_EXCEEDED` - History size limit was exceeded
 * - `INVALID_EDGE` - An invalid edge operation was attempted
 *
 * @example
 * ```typescript
 * // Throw a custom sequential thinking error
 * throw new SequentialThinkingError('Custom error message', 'CUSTOM_CODE');
 *
 * // Check if an error is a SequentialThinkingError
 * if (error instanceof SequentialThinkingError) {
 *   console.error(`Error [${error.code}]: ${error.message}`);
 * }
 * ```
 */
export class SequentialThinkingError extends Error {
	/** The error code for programmatic identification. */
	public readonly code: ErrorCode;

	/**
	 * Creates a new SequentialThinkingError.
	 *
	 * @param message - Human-readable error message
	 * @param code - Error code for programmatic handling
	 *
	 * @example
	 * ```typescript
	 * const error = new SequentialThinkingError(
	 *   'Something went wrong',
	 *   'CUSTOM_ERROR'
	 * );
	 * console.log(error.code); // 'CUSTOM_ERROR'
	 * ```
	 */
	constructor(message: string, code: ErrorCode) {
		super(message);
		this.code = code;
		this.name = 'SequentialThinkingError';
		Error.captureStackTrace(this, this.constructor);
	}
}

export class ConfigurationError extends SequentialThinkingError {
	constructor(message: string) {
		super(message, ERROR_CODES.CONFIGURATION_ERROR);
		this.name = 'ConfigurationError';
	}
}

/**
 * Error thrown when a requested tool is not found in the registry.
 *
 * This error is thrown when attempting to retrieve, update, or delete
 * a tool that doesn't exist in the tool registry.
 *
 * @example
 * ```typescript
 * const tool = registry.get('non-existent-tool');
 * if (!tool) {
 *   throw new ToolNotFoundError('non-existent-tool');
 * }
 * ```
 */
export class ToolNotFoundError extends SequentialThinkingError {
	/**
	 * Creates a new ToolNotFoundError.
	 *
	 * @param toolName - The name of the tool that was not found
	 * @param action - Optional action being performed (e.g., 'remove', 'update')
	 *
	 * @example
	 * ```typescript
	 * throw new ToolNotFoundError('my-custom-tool');
	 * // Error: tool 'my-custom-tool' not found
	 *
	 * throw new ToolNotFoundError('my-custom-tool', 'remove');
	 * // Error: tool 'my-custom-tool' not found, cannot remove
	 * // Code: TOOL_NOT_FOUND
	 * ```
	 */
	constructor(toolName: string, action?: string) {
		const message = action
			? `Tool '${toolName}' not found, cannot ${action}`
			: `Tool '${toolName}' not found`;
		super(message, ERROR_CODES.TOOL_NOT_FOUND);
		this.name = 'ToolNotFoundError';
	}
}

/**
 * Error thrown when a requested skill is not found in the registry.
 *
 * This error is thrown when attempting to retrieve, update, or delete
 * a skill that doesn't exist in the skill registry.
 *
 * @example
 * ```typescript
 * const skill = registry.get('non-existent-skill');
 * if (!skill) {
 *   throw new SkillNotFoundError('non-existent-skill');
 * }
 * ```
 */
export class SkillNotFoundError extends SequentialThinkingError {
	/**
	 * Creates a new SkillNotFoundError.
	 *
	 * @param skillName - The name of the skill that was not found
	 * @param action - Optional action being performed (e.g., 'remove', 'update')
	 *
	 * @example
	 * ```typescript
	 * throw new SkillNotFoundError('my-custom-skill');
	 * // Error: skill 'my-custom-skill' not found
	 *
	 * throw new SkillNotFoundError('my-custom-skill', 'remove');
	 * // Error: skill 'my-custom-skill' not found, cannot remove
	 * // Code: SKILL_NOT_FOUND
	 * ```
	 */
	constructor(skillName: string, action?: string) {
		const message = action
			? `Skill '${skillName}' not found, cannot ${action}`
			: `Skill '${skillName}' not found`;
		super(message, ERROR_CODES.SKILL_NOT_FOUND);
		this.name = 'SkillNotFoundError';
	}
}

/**
 * Error thrown when thought validation fails.
 *
 * This error is thrown when a thought fails validation, typically due to
 * invalid values, missing required fields, or constraint violations.
 *
 * @example
 * ```typescript
 * // Validate thought number
 * if (thought.thought_number < 1) {
 *   throw new InvalidThoughtError(thought.thought_number, 'thought_number must be >= 1');
 * }
 * ```
 */
export class InvalidThoughtError extends SequentialThinkingError {
	/**
	 * Creates a new InvalidThoughtError.
	 *
	 * @param thoughtNumber - The thought number that failed validation
	 * @param reason - Human-readable explanation of why validation failed
	 *
	 * @example
	 * ```typescript
	 * throw new InvalidThoughtError(5, 'thought_number exceeds total_thoughts');
	 * // Error: Invalid thought 5: thought_number exceeds total_thoughts
	 * // Code: INVALID_THOUGHT
	 * ```
	 */
	constructor(thoughtNumber: number, reason: string) {
		super(`Invalid thought ${thoughtNumber}: ${reason}`, ERROR_CODES.INVALID_THOUGHT);
		this.name = 'InvalidThoughtError';
	}
}

/**
 * Error thrown when skill discovery fails.
 *
 * This error is thrown when the skill discovery process encounters an issue,
 * such as filesystem errors, invalid skill files, or parsing failures.
 *
 * @remarks
 * The original error that caused the discovery failure is preserved in the
 * `cause` property for debugging purposes.
 *
 * @example
 * ```typescript
 * try {
 *   await discoverSkills('./skills');
 * } catch (error) {
 *   throw new SkillDiscoveryError('./skills', error as Error);
 * }
 * ```
 */
export class SkillDiscoveryError extends SequentialThinkingError {
	/** The underlying error that caused the discovery failure. */
	public override readonly cause: Error;

	/**
	 * Creates a new SkillDiscoveryError.
	 *
	 * @param directory - The directory where discovery failed
	 * @param cause - The underlying error that caused the failure
	 *
	 * @example
	 * ```typescript
	 * try {
	 *   const skills = await loadSkills('./invalid-directory');
	 * } catch (error) {
	 *   throw new SkillDiscoveryError('./invalid-directory', error as Error);
	 * }
	 * ```
	 */
	constructor(directory: string, cause: Error) {
		super(
			`Failed to discover skills in ${directory}: ${cause.message}`,
			ERROR_CODES.SKILL_DISCOVERY_FAILED
		);
		this.name = 'SkillDiscoveryError';
		this.cause = cause;
	}
}

/**
 * Error thrown when history size exceeds the configured limit.
 *
 * This error is thrown when an operation would cause the history size
 * to exceed the maximum configured size limit.
 *
 * @example
 * ```typescript
 * if (history.length >= maxSize) {
 *   throw new HistoryLimitExceededError(history.length, maxSize);
 * }
 * ```
 */
export class HistoryLimitExceededError extends SequentialThinkingError {
	/**
	 * Creates a new HistoryLimitExceededError.
	 *
	 * @param currentSize - The current history size
	 * @param maxSize - The maximum allowed size
	 *
	 * @example
	 * ```typescript
	 * throw new HistoryLimitExceededError(1500, 1000);
	 * // Error: History size 1500 exceeds limit 1000
	 * // Code: HISTORY_LIMIT_EXCEEDED
	 * ```
	 */
	constructor(currentSize: number, maxSize: number) {
		super(
			`History size ${currentSize} exceeds limit ${maxSize}`,
			ERROR_CODES.HISTORY_LIMIT_EXCEEDED
		);
		this.name = 'HistoryLimitExceededError';
	}
}

/**
 * Error thrown when attempting to add a skill that already exists.
 *
 * This error is thrown when trying to register a skill with a name that
 * is already present in the skill registry.
 *
 * @example
 * ```typescript
 * if (registry.has(skill.name)) {
 *   throw new DuplicateSkillError(skill.name);
 * }
 * ```
 */
export class DuplicateSkillError extends SequentialThinkingError {
	/**
	 * Creates a new DuplicateSkillError.
	 *
	 * @param skillName - The name of the duplicate skill
	 *
	 * @example
	 * ```typescript
	 * throw new DuplicateSkillError('my-skill');
	 * // Error: skill 'my-skill' already exists
	 * // Code: DUPLICATE_SKILL
	 * ```
	 */
	constructor(skillName: string) {
		super(`skill '${skillName}' already exists`, ERROR_CODES.DUPLICATE_SKILL);
		this.name = 'DuplicateSkillError';
	}
}

/**
 * Error thrown when a skill has invalid data.
 *
 * This error is thrown when a skill fails validation, typically due to
 * missing required fields or invalid values.
 *
 * @example
 * ```typescript
 * if (!skill.name) {
 *   throw new InvalidSkillError('Skill must have a valid name');
 * }
 * ```
 */
export class InvalidSkillError extends SequentialThinkingError {
	/**
	 * Creates a new InvalidSkillError.
	 *
	 * @param reason - The reason for the validation failure
	 *
	 * @example
	 * ```typescript
	 * throw new InvalidSkillError('Skill must have a valid name');
	 * // Error: Invalid skill: Skill must have a valid name
	 * // Code: INVALID_SKILL
	 * ```
	 */
	constructor(reason: string) {
		super(`Invalid skill: ${reason}`, ERROR_CODES.INVALID_SKILL);
		this.name = 'InvalidSkillError';
	}
}

/**
 * Error thrown when attempting to add a tool that already exists.
 *
 * This error is thrown when trying to register a tool with a name that
 * is already present in the tool registry.
 *
 * @example
 * ```typescript
 * if (registry.has(tool.name)) {
 *   throw new DuplicateToolError(tool.name);
 * }
 * ```
 */
export class DuplicateToolError extends SequentialThinkingError {
	/**
	 * Creates a new DuplicateToolError.
	 *
	 * @param toolName - The name of the duplicate tool
	 *
	 * @example
	 * ```typescript
	 * throw new DuplicateToolError('my-tool');
	 * // Error: tool 'my-tool' already exists
	 * // Code: DUPLICATE_TOOL
	 * ```
	 */
	constructor(toolName: string) {
		super(`tool '${toolName}' already exists`, ERROR_CODES.DUPLICATE_TOOL);
		this.name = 'DuplicateToolError';
	}
}

/**
 * Error thrown when a tool has invalid data.
 *
 * This error is thrown when a tool fails validation, typically due to
 * missing required fields or invalid values.
 *
 * @example
 * ```typescript
 * if (!tool.name) {
 *   throw new InvalidToolError('Tool must have a valid name');
 * }
 * ```
 */
export class InvalidToolError extends SequentialThinkingError {
	/**
	 * Creates a new InvalidToolError.
	 *
	 * @param reason - The reason for the validation failure
	 *
	 * @example
	 * ```typescript
	 * throw new InvalidToolError('Tool must have a valid name');
	 * // Error: Invalid tool: Tool must have a valid name
	 * // Code: INVALID_TOOL
	 * ```
	 */
	constructor(reason: string) {
		super(`Invalid tool: ${reason}`, ERROR_CODES.INVALID_TOOL);
		this.name = 'InvalidToolError';
	}
}

/**
 * Error thrown when the maximum number of sessions has been reached.
 *
 * This error is thrown when trying to create a new session when the
 * pool has reached its configured maximum session limit.
 *
 * @example
 * ```typescript
 * if (pool.sessionCount >= pool.maxSessions) {
 *   throw new MaxSessionsReachedError(pool.maxSessions);
 * }
 * ```
 */
export class MaxSessionsReachedError extends SequentialThinkingError {
	/**
	 * Creates a new MaxSessionsReachedError.
	 *
	 * @param maxSessions - The maximum number of sessions allowed
	 *
	 * @example
	 * ```typescript
	 * throw new MaxSessionsReachedError(100);
	 * // Error: Max sessions (100) reached. Wait for a session to close or increase maxSessions.
	 * // Code: MAX_SESSIONS_REACHED
	 * ```
	 */
	constructor(maxSessions: number) {
		super(
			`Max sessions (${maxSessions}) reached. Wait for a session to close or increase maxSessions.`,
			ERROR_CODES.MAX_SESSIONS_REACHED
		);
		this.name = 'MaxSessionsReachedError';
	}
}

/**
 * Error thrown when attempting to use a terminated connection pool.
 *
 * This error is thrown when trying to create sessions or process requests
 * after the connection pool has been terminated.
 *
 * @example
 * ```typescript
 * if (pool.isTerminated) {
 *   throw new PoolTerminatedError();
 * }
 * ```
 */
export class PoolTerminatedError extends SequentialThinkingError {
	/**
	 * Creates a new PoolTerminatedError.
	 *
	 * @example
	 * ```typescript
	 * throw new PoolTerminatedError();
	 * // Error: ConnectionPool has been terminated
	 * // Code: POOL_TERMINATED
	 * ```
	 */
	constructor() {
		super('ConnectionPool has been terminated', ERROR_CODES.POOL_TERMINATED);
		this.name = 'PoolTerminatedError';
	}
}

/**
 * Error thrown when input validation fails due to invalid or malicious data.
 *
 * This error is thrown when user input fails security or format validation,
 * such as path traversal attempts or invalid identifier formats.
 *
 * @example
 * ```typescript
 * if (!BRANCH_ID_PATTERN.test(branchId)) {
 *   throw new ValidationError('branchId', 'Invalid format');
 * }
 * ```
 */
export class ValidationError extends SequentialThinkingError {
	/** The field that failed validation. */
	public readonly field: string;

	constructor(field: string, reason: string) {
		super(`Validation failed for '${field}': ${reason}`, ERROR_CODES.VALIDATION_ERROR);
		this.name = 'ValidationError';
		this.field = field;
	}
}

/**
 * Error thrown when an invalid edge operation is attempted.
 *
 * This error is thrown when attempting to add an edge that violates
 * structural invariants of the thought DAG, such as a self-edge
 * (where `from` and `to` reference the same thought).
 *
 * @example
 * ```typescript
 * if (edge.from === edge.to) {
 *   throw new InvalidEdgeError(
 *     `Self-edge not allowed: from and to are the same (${edge.from})`
 *   );
 * }
 * ```
 */
export class InvalidEdgeError extends SequentialThinkingError {
	/**
	 * Creates a new InvalidEdgeError.
	 *
	 * @param message - Human-readable explanation of the invalid edge
	 *
	 * @example
	 * ```typescript
	 * throw new InvalidEdgeError('Self-edge not allowed: from and to are the same (t1)');
	 * // Code: INVALID_EDGE
	 * ```
	 */
	constructor(message: string) {
		super(message, ERROR_CODES.INVALID_EDGE);
		this.name = 'InvalidEdgeError';
	}
}

/**
 * Error thrown when a cycle is detected during graph traversal.
 *
 * This error is thrown by graph algorithms (such as topological sort)
 * when the thought DAG contains a cycle, violating the acyclic invariant.
 *
 * @example
 * ```typescript
 * try {
 *   const order = graphView.topological(sessionId);
 * } catch (error) {
 *   if (error instanceof CycleDetectedError) {
 *     console.error('Cycle in thought graph:', error.message);
 *   }
 * }
 * ```
 */
export class CycleDetectedError extends SequentialThinkingError {
	/**
	 * Creates a new CycleDetectedError.
	 *
	 * @param message - Human-readable explanation of the cycle
	 *
	 * @example
	 * ```typescript
	 * throw new CycleDetectedError('Cycle detected in session s1');
	 * // Code: CYCLE_DETECTED
	 * ```
	 */
	constructor(message: string) {
		super(message, ERROR_CODES.CYCLE_DETECTED);
		this.name = 'CycleDetectedError';
	}
}

/**
 * Error thrown when a suspension record is not found.
 *
 * This error is thrown when attempting to resume a tool interleave
 * suspension that does not exist in the suspension store.
 */
export class SuspensionNotFoundError extends SequentialThinkingError {
	constructor(message: string) {
		super(message, ERROR_CODES.SUSPENSION_NOT_FOUND);
		this.name = 'SuspensionNotFoundError';
	}
}

/**
 * Error thrown when a suspension record has expired.
 *
 * This error is thrown when attempting to resume a tool interleave
 * suspension whose TTL has elapsed.
 */
export class SuspensionExpiredError extends SequentialThinkingError {
	constructor(message: string) {
		super(message, ERROR_CODES.SUSPENSION_EXPIRED);
		this.name = 'SuspensionExpiredError';
	}
}

/**
 * Error thrown when a tool call payload is invalid.
 *
 * This error is thrown when a tool interleave invocation has malformed
 * arguments, missing identifiers, or otherwise fails validation.
 */
export class InvalidToolCallError extends SequentialThinkingError {
	constructor(message: string) {
		super(message, ERROR_CODES.INVALID_TOOL_CALL);
		this.name = 'InvalidToolCallError';
	}
}

/**
 * Error thrown when a backtrack operation is invalid.
 *
 * This error is thrown when an attempt to backtrack the reasoning
 * chain references an unreachable thought or violates DAG invariants.
 */
export class InvalidBacktrackError extends SequentialThinkingError {
	constructor(message: string) {
		super(message, ERROR_CODES.INVALID_BACKTRACK);
		this.name = 'InvalidBacktrackError';
	}
}

/**
 * Error thrown when a tool_call references a tool not registered with the server.
 *
 * Acts as an allowlist gate: only tools registered in the ToolRegistry may be
 * invoked through tool interleave. Prevents arbitrary tool name injection.
 */
export class UnknownToolError extends SequentialThinkingError {
	public readonly toolName: string;

	constructor(toolName: string, message?: string) {
		super(
			message ?? `Unknown tool '${toolName}': not registered with the server`,
			ERROR_CODES.UNKNOWN_TOOL
		);
		this.name = 'UnknownToolError';
		this.toolName = toolName;
	}
}

/** Error thrown when the CLI's complete shutdown exceeds its outer deadline. */
export class CliShutdownTimeoutError extends SequentialThinkingError {
	public readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`CLI shutdown timed out after ${timeoutMs}ms`, ERROR_CODES.CLI_SHUTDOWN_TIMEOUT);
		this.name = 'CliShutdownTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

export class PersistenceOwnershipError extends SequentialThinkingError {
	public readonly canonicalDataDir: string;
	public readonly lockPath: string;
	public override readonly cause: unknown;

	constructor(canonicalDataDir: string, lockPath: string, cause: unknown) {
		super(
			`Persistence directory '${canonicalDataDir}' already has an active writer`,
			ERROR_CODES.PERSISTENCE_OWNERSHIP
		);
		this.name = 'PersistenceOwnershipError';
		this.canonicalDataDir = canonicalDataDir;
		this.lockPath = lockPath;
		this.cause = cause;
	}
}

export class PersistenceCorruptionError extends SequentialThinkingError {
	public readonly path: string;
	public override readonly cause: unknown;

	constructor(path: string, cause: unknown) {
		super(
			`Persisted data at '${path}' is corrupt or incompatible`,
			ERROR_CODES.PERSISTENCE_CORRUPTION
		);
		this.name = 'PersistenceCorruptionError';
		this.path = path;
		this.cause = cause;
	}
}

/** Error raised when startup cannot read from an unhealthy persistence backend. */
export class PersistenceUnavailableError extends SequentialThinkingError {
	constructor() {
		super(
			'Persistence backend is unavailable during startup restore',
			ERROR_CODES.PERSISTENCE_UNAVAILABLE
		);
		this.name = 'PersistenceUnavailableError';
	}
}

export type PersistencePublicationStage = 'temporary-write' | 'atomic-replacement' | 'cleanup';

export class PersistencePublicationError extends SequentialThinkingError {
	public readonly path: string;
	public readonly stage: PersistencePublicationStage;
	public override readonly cause: unknown;

	constructor(path: string, stage: PersistencePublicationStage, cause: unknown) {
		super(
			`Failed persistence publication for '${path}' during ${stage}`,
			ERROR_CODES.PERSISTENCE_PUBLICATION
		);
		this.name = 'PersistencePublicationError';
		this.path = path;
		this.stage = stage;
		this.cause = cause;
	}
}

export class PersistenceClosedError extends SequentialThinkingError {
	public readonly dataDir: string;

	constructor(dataDir: string) {
		super(`Persistence writer for '${dataDir}' is closed`, ERROR_CODES.PERSISTENCE_CLOSED);
		this.name = 'PersistenceClosedError';
		this.dataDir = dataDir;
	}
}

/** Error raised for well-formed but unsupported or drifted persisted data. */
export class PersistenceCompatibilityError extends SequentialThinkingError {
	public readonly sourcePath: string;
	public readonly detail: string;
	public override readonly cause: unknown;

	constructor(sourcePath: string, detail: string, cause?: unknown) {
		super(
			`Persisted data at '${sourcePath}' is incompatible: ${detail}`,
			ERROR_CODES.PERSISTENCE_COMPATIBILITY
		);
		this.name = 'PersistenceCompatibilityError';
		this.sourcePath = sourcePath;
		this.detail = detail;
		this.cause = cause;
	}
}

/**
 * Type guard to check if an error has a specific error code.
 */
export function isErrorCode<C extends ErrorCode>(
	err: unknown,
	code: C
): err is SequentialThinkingError & { readonly code: C } {
	return err instanceof SequentialThinkingError && err.code === code;
}

/**
 * Extract a human-readable message from an unknown error value.
 *
 * Standardizes the common `error instanceof Error ? error.message : String(error)`
 * pattern used in catch blocks across the codebase.
 *
 * @param error - The unknown error value to extract a message from
 * @returns The error message string
 *
 * @example
 * ```typescript
 * try {
 *   await doSomething();
 * } catch (error) {
 *   logger.error('Failed', { error: getErrorMessage(error) });
 * }
 * ```
 */
export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
