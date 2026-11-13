import { describe, it, expect } from 'vitest';
import {
	SequentialThinkingError,
	ConfigurationError,
	ToolNotFoundError,
	DuplicateToolError,
	InvalidToolError,
	SkillNotFoundError,
	DuplicateSkillError,
	InvalidSkillError,
	InvalidThoughtError,
	SkillDiscoveryError,
	HistoryLimitExceededError,
	MaxSessionsReachedError,
	PoolTerminatedError,
	PersistenceCompatibilityError,
	PersistenceUnavailableError,
	ServerStopTimeoutError,
	ValidationError,
} from '../errors.js';
import { asSessionId } from '../contracts/ids.js';
import type { ErrorCode } from '../errors.js';
import { SessionLifecycleClosedError } from '../core/SessionErrors.js';
import { SessionNotActiveError, SessionNotFoundError } from '../pool/PoolErrors.js';

describe('Custom Error Types', () => {
	describe('SequentialThinkingError', () => {
		it('should create base error with code', () => {
			const error = new SequentialThinkingError('Test error', 'TEST_CODE' as ErrorCode);
			expect(error.message).toBe('Test error');
			expect(error.code).toBe('TEST_CODE');
			expect(error.name).toBe('SequentialThinkingError');
		});

		it('should capture stack trace', () => {
			const error = new SequentialThinkingError('Test', 'CODE' as ErrorCode);
			expect(error.stack).toBeDefined();
		});
	});

	describe('ToolNotFoundError', () => {
		it('should create tool not found error', () => {
			const error = new ToolNotFoundError('test-tool');
			expect(error.message).toBe("Tool 'test-tool' not found");
			expect(error.code).toBe('TOOL_NOT_FOUND');
			expect(error.name).toBe('ToolNotFoundError');
		});
	});

	describe('DuplicateToolError', () => {
		it('should create duplicate tool error', () => {
			const error = new DuplicateToolError('test-tool');
			expect(error.message).toBe("tool 'test-tool' already exists");
			expect(error.code).toBe('DUPLICATE_TOOL');
			expect(error.name).toBe('DuplicateToolError');
		});
	});

	describe('InvalidToolError', () => {
		it('should create invalid tool error', () => {
			const error = new InvalidToolError('Tool must have a valid name');
			expect(error.message).toBe('Invalid tool: Tool must have a valid name');
			expect(error.code).toBe('INVALID_TOOL');
			expect(error.name).toBe('InvalidToolError');
		});
	});

	describe('SkillNotFoundError', () => {
		it('should create skill not found error', () => {
			const error = new SkillNotFoundError('test-skill');
			expect(error.message).toBe("Skill 'test-skill' not found");
			expect(error.code).toBe('SKILL_NOT_FOUND');
			expect(error.name).toBe('SkillNotFoundError');
		});
	});

	describe('DuplicateSkillError', () => {
		it('should create duplicate skill error', () => {
			const error = new DuplicateSkillError('test-skill');
			expect(error.message).toBe("skill 'test-skill' already exists");
			expect(error.code).toBe('DUPLICATE_SKILL');
			expect(error.name).toBe('DuplicateSkillError');
		});
	});

	describe('InvalidSkillError', () => {
		it('should create invalid skill error', () => {
			const error = new InvalidSkillError('Skill must have a valid name');
			expect(error.message).toBe('Invalid skill: Skill must have a valid name');
			expect(error.code).toBe('INVALID_SKILL');
			expect(error.name).toBe('InvalidSkillError');
		});
	});

	describe('ConfigurationError', () => {
		it('constructs with message and configuration error code', () => {
			const error = new ConfigurationError('Invalid configuration value');
			expect(error.message).toBe('Invalid configuration value');
			expect(error.code).toBe('CONFIGURATION_ERROR');
			expect(error.name).toBe('ConfigurationError');
		});

		it('is instance of SequentialThinkingError and Error', () => {
			const error = new ConfigurationError('Invalid configuration value');
			expect(error).toBeInstanceOf(SequentialThinkingError);
			expect(error).toBeInstanceOf(Error);
		});

		it('can be caught as SequentialThinkingError and has stack trace', () => {
			let caught: SequentialThinkingError | undefined;

			try {
				throw new ConfigurationError('Invalid configuration value');
			} catch (error) {
				if (error instanceof SequentialThinkingError) {
					caught = error;
				}
			}

			expect(caught).toBeDefined();
			expect(caught?.name).toBe('ConfigurationError');
			expect(caught?.stack).toBeDefined();
		});
	});

	describe('InvalidThoughtError', () => {
		it('should create invalid thought error', () => {
			const error = new InvalidThoughtError(5, 'Missing required field');
			expect(error.message).toBe('Invalid thought 5: Missing required field');
			expect(error.code).toBe('INVALID_THOUGHT');
			expect(error.name).toBe('InvalidThoughtError');
		});
	});

	describe('SkillDiscoveryError', () => {
		it('should create skill discovery error with cause', () => {
			const cause = new Error('Directory not found');
			const error = new SkillDiscoveryError('/test/dir', cause);
			expect(error.message).toBe('Failed to discover skills in /test/dir: Directory not found');
			expect(error.code).toBe('SKILL_DISCOVERY_FAILED');
			expect(error.name).toBe('SkillDiscoveryError');
			expect(error.cause).toBe(cause);
		});
	});

	describe('HistoryLimitExceededError', () => {
		it('should create history limit error', () => {
			const error = new HistoryLimitExceededError(1500, 1000);
			expect(error.message).toBe('History size 1500 exceeds limit 1000');
			expect(error.code).toBe('HISTORY_LIMIT_EXCEEDED');
			expect(error.name).toBe('HistoryLimitExceededError');
		});
	});

	describe('ValidationError', () => {
		it('should create validation error', () => {
			const error = new ValidationError('branchId', 'Invalid format');
			expect(error.message).toBe("Validation failed for 'branchId': Invalid format");
			expect(error.code).toBe('VALIDATION_ERROR');
			expect(error.name).toBe('ValidationError');
			expect(error.field).toBe('branchId');
		});

		it('is the imported constructor when asSessionId rejects an invalid value', () => {
			let caught: unknown;

			try {
				asSessionId('invalid session');
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(ValidationError);
			if (!(caught instanceof ValidationError)) {
				throw new Error('Expected asSessionId to throw ValidationError');
			}
			expect(caught.constructor).toBe(ValidationError);
			expect(caught).toMatchObject({
				field: 'session_id',
				code: 'VALIDATION_ERROR',
				message:
					"Validation failed for 'session_id': must match alphanumeric, hyphens, underscores",
			});
		});
	});

});

describe('SessionNotActiveError', () => {
	it('should create session not active error', () => {
		const error = new SessionNotActiveError(asSessionId('test-session'));
		expect(error.message).toBe("Session 'test-session' is not active");
		expect(error.code).toBe('SESSION_NOT_ACTIVE');
		expect(error.name).toBe('SessionNotActiveError');
	});

	it('remains a SequentialThinkingError and Error', () => {
		const error = new SessionNotActiveError(asSessionId('test-session'));
		expect(error).toBeInstanceOf(SequentialThinkingError);
		expect(error).toBeInstanceOf(Error);
	});
});

describe('SessionNotFoundError', () => {
	it('should create session not found error', () => {
		const error = new SessionNotFoundError(asSessionId('missing-session'));
		expect(error.message).toBe('Session not found: missing-session');
		expect(error.code).toBe('SESSION_NOT_FOUND');
		expect(error.name).toBe('SessionNotFoundError');
	});

	it('remains a SequentialThinkingError and Error', () => {
		const error = new SessionNotFoundError(asSessionId('missing-session'));
		expect(error).toBeInstanceOf(SequentialThinkingError);
		expect(error).toBeInstanceOf(Error);
	});
});

describe('MaxSessionsReachedError', () => {
	it('should create max sessions error with limit', () => {
		const error = new MaxSessionsReachedError(100);
		expect(error.message).toBe(
			'Max sessions (100) reached. Wait for a session to close or increase maxSessions.'
		);
		expect(error.code).toBe('MAX_SESSIONS_REACHED');
		expect(error.name).toBe('MaxSessionsReachedError');
	});
});

describe('SessionLifecycleClosedError', () => {
	it('carries the closed session and lifecycle phase', () => {
		// Given
		const sessionId = asSessionId('closed-session');

		// When
		const error = new SessionLifecycleClosedError(sessionId, 'eviction_failed');

		// Then
		expect(error).toMatchObject({
			name: 'SessionLifecycleClosedError',
			code: 'SESSION_LIFECYCLE_CLOSED',
			sessionId,
			phase: 'eviction_failed',
			message: "Session 'closed-session' lifecycle admission is closed in phase 'eviction_failed'",
		});
	});
});

describe('PoolTerminatedError', () => {
	it('should create pool terminated error', () => {
		const error = new PoolTerminatedError();
		expect(error.message).toBe('ConnectionPool has been terminated');
		expect(error.code).toBe('POOL_TERMINATED');
		expect(error.name).toBe('PoolTerminatedError');
	});
});

describe('Persistence startup errors', () => {
	it('uses distinct stable codes when unavailable and incompatible failures differ', () => {
		// Given
		const sourcePath = '/data/snapshot.json';
		const detail = 'unsupported schema';

		// When
		const unavailable = new PersistenceUnavailableError();
		const compatibility = new PersistenceCompatibilityError(sourcePath, detail);

		// Then
		expect(unavailable.code).toBe('PERSISTENCE_UNAVAILABLE');
		expect(compatibility.code).toBe('PERSISTENCE_COMPATIBILITY');
		expect(unavailable.code).not.toBe(compatibility.code);
	});
});

describe('ServerStopTimeoutError', () => {
	it.each([
		{ phase: 'operations' as const, timeoutMs: 4668, pending: 3 },
		{ phase: 'flush' as const, timeoutMs: 4666, pending: 7 },
		{ phase: 'discovery' as const, timeoutMs: 4668, pending: null },
	])('carries the $phase phase, its deadline and its pending count', (expected) => {
		// Given / When
		const error = new ServerStopTimeoutError(expected.phase, expected.timeoutMs, expected.pending);

		// Then
		expect(error).toBeInstanceOf(SequentialThinkingError);
		expect(error).toMatchObject({
			name: 'ServerStopTimeoutError',
			code: 'SERVER_STOP_TIMEOUT',
			...expected,
		});
	});
});
