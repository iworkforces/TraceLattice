import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import type { IEdgeStore } from '../contracts/interfaces.js';
import type { SessionId } from '../contracts/ids.js';
import type { ISummaryStore } from '../contracts/summary.js';
import type { Logger } from '../logger/StructuredLogger.js';
interface ResetBarrier {
	withSessionResetBarrier(sessionId: SessionId, operation: () => Promise<void>): Promise<void>;
	withGlobalResetBarrier(operation: () => Promise<void>): Promise<void>;
}

interface SessionResetCoordinatorBaseConfig<SessionState> {
	readonly edgeStore?: IEdgeStore;
	readonly summaryStore?: ISummaryStore;
	readonly sessions: Map<SessionId, SessionState>;
	readonly createSessionState: (owner: string | undefined) => SessionState;
	readonly assertReplacementCapacity: (sessionId: SessionId, owner: string | undefined) => void;
	readonly admitReplacement: (sessionId: SessionId, owner: string | undefined) => void;
	readonly logger: Logger;
}

type ResetDurability =
	| { readonly persistence: null; readonly barrier: null }
	| { readonly persistence: PersistenceBackend; readonly barrier: ResetBarrier };

export type SessionResetCoordinatorConfig<SessionState> =
	SessionResetCoordinatorBaseConfig<SessionState> & ResetDurability;

export class SessionResetCoordinator<SessionState> {
	private readonly _durability: ResetDurability;
	private readonly _edgeStore?: IEdgeStore;
	private readonly _summaryStore?: ISummaryStore;
	private readonly _sessions: Map<SessionId, SessionState>;
	private readonly _createSessionState: (owner: string | undefined) => SessionState;
	private readonly _logger: Logger;
	private readonly _assertReplacementCapacity: SessionResetCoordinatorBaseConfig<SessionState>['assertReplacementCapacity'];
	private readonly _admitReplacement: SessionResetCoordinatorBaseConfig<SessionState>['admitReplacement'];

	constructor(config: SessionResetCoordinatorConfig<SessionState>) {
		this._durability = config;
		this._edgeStore = config.edgeStore;
		this._summaryStore = config.summaryStore;
		this._sessions = config.sessions;
		this._createSessionState = config.createSessionState;
		this._logger = config.logger;
		this._assertReplacementCapacity = config.assertReplacementCapacity;
		this._admitReplacement = config.admitReplacement;
	}

	async resetSession(
		sessionId: SessionId,
		preservedOwner: string | undefined,
		clearAuxiliaryState?: () => void
	): Promise<void> {
		this._assertReplacementCapacity(sessionId, preservedOwner);
		const durability = this._durability;
		if (durability.persistence === null) {
			this._replaceLiveSession(sessionId, preservedOwner);
			clearAuxiliaryState?.();
			return;
		}
		await durability.barrier.withSessionResetBarrier(sessionId, async () => {
			await durability.persistence.clearSession(sessionId);
			this._replaceLiveSession(sessionId, preservedOwner);
			clearAuxiliaryState?.();
		});
	}

	async resetAll(clearAuxiliaryState?: () => void): Promise<void> {
		const durability = this._durability;
		if (durability.persistence === null) {
			this._clearAllLiveState();
			clearAuxiliaryState?.();
			return;
		}
		await durability.barrier.withGlobalResetBarrier(async () => {
			await durability.persistence.clearAll();
			this._clearAllLiveState();
			clearAuxiliaryState?.();
		});
	}

	private _replaceLiveSession(sessionId: SessionId, owner: string | undefined): void {
		this._admitReplacement(sessionId, owner);
		this._clearSessionStores(sessionId);
		this._sessions.set(sessionId, this._createSessionState(owner));
		this._logger.info('Session reset', { sessionId });
	}

	private _clearSessionStores(sessionId: SessionId): void {
		this._edgeStore?.clearSession(sessionId);
		this._summaryStore?.clearSession(sessionId);
	}

	private _clearAllLiveState(): void {
		this._edgeStore?.clearAll();
		this._summaryStore?.clearAll();
		this._sessions.clear();
		this._logger.info('History cleared (all sessions)');
	}
}
