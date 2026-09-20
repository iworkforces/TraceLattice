import type { BranchId, SessionId } from '../contracts/ids.js';
import { ERROR_CODES, SequentialThinkingError } from '../errors.js';

/** Durable namespace associated with a persistence write. */
export type PersistenceScope = {
	readonly sessionId: SessionId;
	readonly branchId?: BranchId;
};

/** Operations whose payload ownership is validated before mutation. */
export type PersistenceWriteOperation =
	| 'saveThought'
	| 'saveThoughtForSession'
	| 'saveBranch'
	| 'saveBranchForSession'
	| 'saveEdges'
	| 'saveSummaries';

/** Error raised before a write whose payload belongs to another namespace. */
export class PersistenceScopeMismatchError extends SequentialThinkingError {
	public readonly operation: PersistenceWriteOperation;
	public readonly expectedScope: PersistenceScope;
	public readonly actualScopes: readonly PersistenceScope[];

	constructor(
		operation: PersistenceWriteOperation,
		expectedScope: PersistenceScope,
		actualScopes: readonly PersistenceScope[]
	) {
		super(
			`Persistence payload scope does not match '${expectedScope.sessionId}' for ${operation}`,
			ERROR_CODES.PERSISTENCE_SCOPE_MISMATCH
		);
		this.name = 'PersistenceScopeMismatchError';
		this.operation = operation;
		this.expectedScope = expectedScope;
		this.actualScopes = [...actualScopes];
	}
}
