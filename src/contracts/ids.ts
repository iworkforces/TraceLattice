/**
 * Branded identifier types for compile-time slot safety.
 *
 * These nominal types prevent accidental mixing of different ID kinds
 * (e.g. passing a `ThoughtId` where a `SessionId` is expected). At
 * runtime they are plain strings — the brand exists only in the type
 * system.
 *
 * @module contracts/ids
 */

import { generateUlid, MAX_SESSION_ID_LENGTH, SESSION_ID_PATTERN } from '../core/ids.js';
import { ValidationError } from '../errors.js';

declare const __brand: unique symbol;

/**
 * Nominal brand helper.
 *
 * The brand is a phantom property — it exists at the type level only
 * and carries zero runtime cost.
 */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Branded session identifier. */
export type SessionId = Brand<string, 'SessionId'>;

/** Branded thought identifier. */
export type ThoughtId = Brand<string, 'ThoughtId'>;

/** Branded edge identifier. */
export type EdgeId = Brand<string, 'EdgeId'>;

/** Branded suspension token. */
export type SuspensionToken = Brand<string, 'SuspensionToken'>;

/** Branded branch identifier. */
export type BranchId = Brand<string, 'BranchId'>;

/** Branded summary identifier. */
export type SummaryId = Brand<string, 'SummaryId'>;

/**
 * Validate and brand a string as a {@link SessionId}.
 *
 * Enforces {@link SESSION_ID_PATTERN} and {@link MAX_SESSION_ID_LENGTH}.
 * The retired global session sentinel `__global__` is rejected.
 *
 * @throws {ValidationError} when the input is not a valid session id.
 */
export function asSessionId(value: string): SessionId {
	if (value === '__global__') {
		throw new ValidationError(
			'session_id',
			"reserved value '__global__' is retired; use an explicit named session"
		);
	}
	if (typeof value !== 'string' || value.length === 0) {
		throw new ValidationError('session_id', 'must be a non-empty string');
	}
	if (value.length > MAX_SESSION_ID_LENGTH) {
		throw new ValidationError('session_id', `exceeds max length of ${MAX_SESSION_ID_LENGTH}`);
	}
	if (!SESSION_ID_PATTERN.test(value)) {
		throw new ValidationError('session_id', 'must match alphanumeric, hyphens, underscores');
	}
	// eslint-disable-next-line no-restricted-syntax -- branding constructor, cannot self-reference
	return value as SessionId;
}

/** Brand a string as a {@link ThoughtId} without validation. */
export function asThoughtId(value: string): ThoughtId {
	return value as ThoughtId;
}

/** Brand a string as an {@link EdgeId} without validation. */
export function asEdgeId(value: string): EdgeId {
	return value as EdgeId;
}

/** Brand a string as a {@link SuspensionToken} without validation. */
export function asSuspensionToken(value: string): SuspensionToken {
	return value as SuspensionToken;
}

/** Brand a string as a {@link BranchId} without validation. */
export function asBranchId(value: string): BranchId {
	return value as BranchId;
}

/** Brand a string as a {@link SummaryId} without validation. */
export function asSummaryId(value: string): SummaryId {
	return value as SummaryId;
}

/** Generate a fresh {@link ThoughtId}. */
export function generateThoughtId(): ThoughtId {
	return generateUlid() as ThoughtId;
}

/** Generate a fresh {@link EdgeId}. */
export function generateEdgeId(): EdgeId {
	return generateUlid() as EdgeId;
}

/** Generate a fresh {@link SuspensionToken}. */
export function generateSuspensionToken(): SuspensionToken {
	return generateUlid() as SuspensionToken;
}

/** Generate a fresh {@link SummaryId}. */
export function generateSummaryId(): SummaryId {
	return generateUlid() as SummaryId;
}
