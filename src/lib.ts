// Library exports for tracelattice
// This module contains all public API exports with NO CLI side effects.
// For the CLI entry point, see cli.ts.

import { EventEmitter } from 'node:events';
import type * as v from 'valibot';
import type { ThoughtData } from './core/thought.js';
import { asSessionId, type BranchId } from './contracts/ids.js';
import type { SequentialThinkingSchema } from './schema.js';
import { SEQUENTIAL_THINKING_TOOL } from './schema.js';
import type { IDisposable } from './types/disposable.js';
import { getErrorMessage } from './errors.js';
import { assertNever } from './utils.js';

// New component imports
import { DiscoveryCache } from './cache/DiscoveryCache.js';
import type { ConfigFileOptions } from './config/ConfigLoader.js';
import { ConfigLoader } from './config/ConfigLoader.js';
import { ABSOLUTE_MAX_HISTORY_SIZE, HistoryManager } from './core/HistoryManager.js';
import { EdgeStore } from './core/graph/EdgeStore.js';
import { InMemorySummaryStore } from './core/compression/InMemorySummaryStore.js';
import { CompressionService } from './core/compression/CompressionService.js';
import { InMemorySuspensionStore } from './core/tools/InMemorySuspensionStore.js';
import { ThoughtEvaluator } from './core/ThoughtEvaluator.js';
import { Calibrator } from './core/evaluator/Calibrator.js';
import { OutcomeRecorder } from './core/reasoning/OutcomeRecorder.js';
import { createReasoningStrategy } from './core/reasoning/strategies/StrategyFactory.js';
import { ThoughtFormatter } from './core/ThoughtFormatter.js';
import { ThoughtProcessor, type CallToolResult } from './core/ThoughtProcessor.js';
import { SessionLock } from './core/SessionLock.js';
import { SessionLifecycleClosedError } from './core/SessionErrors.js';
import { SessionLifecycleCoordinator } from './core/SessionLifecycleCoordinator.js';
import { Container } from './di/Container.js';
import { StructuredLogger } from './logger/StructuredLogger.js';
import { Metrics } from './metrics/metrics.impl.js';
import type { PersistenceBackend } from './contracts/PersistenceBackend.js';
import { createPersistenceBackend } from './persistence/PersistenceFactory.js';
import { SkillRegistry } from './registry/SkillRegistry.js';
import { ToolRegistry } from './registry/ToolRegistry.js';
import { ServerConfig } from './ServerConfig.js';
import { SkillWatcher } from './watchers/SkillWatcher.js';
import { ToolWatcher } from './watchers/ToolWatcher.js';
import { HttpTransport, createHttpTransport } from './transport/HttpTransport.js';
import type { HttpTransportOptions } from './transport/HttpTransport.js';
import type { TransportOptions } from './transport/BaseTransport.js';
import type { ITransport, TransportKind } from './contracts/transport.js';

export { HttpTransport, createHttpTransport };
export type { HttpTransportOptions, TransportOptions, ITransport, TransportKind };

export interface ServerOptions {
	maxHistorySize?: number;
	maxBranches?: number;
	maxBranchSize?: number;
	logger?: StructuredLogger;
	enableWatcher?: boolean;
	config?: ServerConfig;
	fileConfig?: ConfigFileOptions;
	container?: Container;
	/**
	 * Enable automatic tool and skill discovery on server startup.
	 * @default true
	 */
	autoDiscover?: boolean;
	/**
	 * Suppress startup discovery so callers can discover through registry APIs explicitly.
	 * @default false
	 */
	lazyDiscovery?: boolean;
	/**
	 * Load history from persistence on initialization
	 * @default true
	 */
	loadFromPersistence?: boolean;
}

/**
 * Server error events for event-driven error handling
 */
interface ServerEvents {
	persistenceError: { operation: string; error: Error };
	discoveryError: { directory: string; error: Error };
	transportError: { transport: string; error: Error };
	thoughtProcessed: { thoughtNumber: number; duration: number };
}

type CleanupOperation = () => void | Promise<void>;

function appendCleanupFailure(failures: unknown[], failure: unknown): void {
	if (failure instanceof AggregateError) {
		failures.push(...failure.errors);
		return;
	}
	failures.push(failure);
}

async function collectCleanupFailures(operations: readonly CleanupOperation[]): Promise<unknown[]> {
	const failures: unknown[] = [];
	for (const operation of operations) {
		try {
			await operation();
		} catch (error) {
			appendCleanupFailure(failures, error);
		}
	}
	return failures;
}

/**
 * Public API contract for the tool-aware sequential thinking server.
 *
 * Extends {@link IDisposable} for resource cleanup. Concrete implementations
 * are expected to also extend Node's `EventEmitter` to support the typed
 * `emit`/`on` overloads.
 */
export interface IToolAwareSequentialThinkingServer extends IDisposable {
	/** Direct access to the history manager. */
	readonly history: HistoryManager;

	/** Direct access to the tool registry. */
	readonly tools: ToolRegistry;

	/** Direct access to the skill registry. */
	readonly skills: SkillRegistry;

	/** Server configuration. */
	readonly config: ServerConfig;

	/**
	 * Discover skills asynchronously without blocking server startup.
	 *
	 * @returns The number of skills discovered
	 */
	discoverSkillsAsync(): Promise<number>;

	/** Rescan configured tool and skill directories. */
	refreshDiscovery(): Promise<{ tools: number; skills: number }>;

	/**
	 * Get all branches for one explicit thought session.
	 *
	 * @param sessionId - Valid thought-session identifier
	 * @returns Map of branch IDs to thought arrays
	 */
	getBranches(sessionId: string): Record<string, ThoughtData[]>;

	/**
	 * Process a thought through the configured pipeline.
	 *
	 * @param input - Validated thought input matching the schema
	 * @returns The processing result
	 */
	processThought(input: v.InferInput<typeof SequentialThinkingSchema>): Promise<CallToolResult>;

	/**
	 * Export the current Prometheus metrics snapshot.
	 */
	getMetricsSnapshot(): string;

	/**
	 * Get the DI container used by this server.
	 * Useful for testing and advanced customizations.
	 */
	getContainer(): Container;

	/**
	 * Stop the server and clean up watchers, suspension stores, and persistence.
	 */
	stop(): Promise<void>;

	/** Awaitably reset one session and all matching auxiliary state. */
	resetSession(sessionId: string): Promise<void>;

	/** Awaitably reset all state from a trusted ownerless context. */
	resetAll(): Promise<void>;

	/**
	 * Dispose of the server and all container services.
	 */
	dispose(): Promise<void>;
}

export class ToolAwareSequentialThinkingServer
	extends EventEmitter
	implements IToolAwareSequentialThinkingServer
{
	/**
	 * Factory method to create a new server instance with async initialization.
	 * This is the recommended way to create server instances.
	 *
	 * @param options - Server configuration options
	 * @returns A Promise that resolves to a configured server instance
	 */
	static async create(options: ServerOptions = {}): Promise<ToolAwareSequentialThinkingServer> {
		const container = await ToolAwareSequentialThinkingServer._createContainerAsyncStatic(options);
		let server: ToolAwareSequentialThinkingServer | undefined;
		try {
			server = new ToolAwareSequentialThinkingServer({
				...options,
				container,
			});
			await Promise.all([
				server._skillWatcher?.ready() ?? Promise.resolve(),
				server._toolWatcher?.ready() ?? Promise.resolve(),
			]);

			if (options.loadFromPersistence !== false) {
				await server.history.loadFromPersistence();
			}

			if (options.autoDiscover !== false && options.lazyDiscovery !== true) {
				await Promise.all([server.tools.discoverAsync(), server.discoverSkillsAsync()]);
			}

			return server;
		} catch (error) {
			const startedServer = server;
			const cleanupFailures = await collectCleanupFailures(
				startedServer
					? [() => startedServer.dispose()]
					: [
							() => {
								if (container.has('suspensionStore')) {
									container.resolve('suspensionStore').stop();
								}
							},
							() => container.resolve('Persistence')?.close(),
							() => container.dispose(),
						]
			);
			if (cleanupFailures.length > 0) {
				throw new AggregateError(
					[error, ...cleanupFailures],
					'Server startup failed and cleanup also failed',
					{ cause: error }
				);
			}
			throw error;
		}
	}

	// Type-safe event emission
	override emit<K extends keyof ServerEvents>(event: K, payload: ServerEvents[K]): boolean {
		return super.emit(event, payload);
	}

	override on<K extends keyof ServerEvents>(
		event: K,
		listener: (payload: ServerEvents[K]) => void
	): this {
		return super.on(event, listener);
	}

	// DI Container for managing dependencies
	private _container: Container;

	// Component instances (private)
	private _logger: StructuredLogger;
	private _historyManager: HistoryManager;
	private _thoughtProcessor: ThoughtProcessor;
	private _metrics: Metrics;
	private _skillWatcher: SkillWatcher | null = null;
	private _toolWatcher: ToolWatcher | null = null;
	private _config: ServerConfig;
	private _acceptingDiscoveryRefreshes = true;
	private _refreshPromise: Promise<{ tools: number; skills: number }> | null = null;
	private _stopPromise: Promise<void> | null = null;
	private _disposePromise: Promise<void> | null = null;

	// Public manager properties (recommended API)
	/**
	 * Direct access to the history manager
	 * @example
	 * ```typescript
	 * server.history.getHistory('analysis-session');
	 * await server.resetAll();
	 * ```
	 */
	public readonly history: HistoryManager;

	/**
	 * Direct access to the tool registry
	 * @example
	 * ```typescript
	 * server.tools.add(tool);
	 * server.tools.get('my-tool');
	 * ```
	 */
	public readonly tools: ToolRegistry;

	/**
	 * Direct access to the skill registry
	 * @example
	 * ```typescript
	 * server.skills.add(skill);
	 * server.skills.get('my-skill');
	 * ```
	 */
	public readonly skills: SkillRegistry;

	/**
	 * Server configuration
	 * @example
	 * ```typescript
	 * console.log(server.config.maxHistorySize);
	 * ```
	 */
	public readonly config: ServerConfig;

	constructor(options: ServerOptions = {}) {
		// Use provided container or create a new one
		super();
		if (!options.container) {
			throw new Error('Container is required. Use createServer() or provide a container.');
		}
		this._container = options.container;

		// Resolve dependencies from container
		this._logger = this._container.resolve('Logger');
		this._historyManager = this._container.resolve('HistoryManager');
		this._historyManager.bindShutdownOwner(() => this.stop());
		this._thoughtProcessor = this._container.resolve('ThoughtProcessor');
		this._metrics = this._container.resolve('Metrics');
		this._config = this._container.resolve('Config');

		// Expose managers as public properties (recommended API)
		this.history = this._historyManager;

		// Wire up persistence error event emitter
		this._historyManager.setEventEmitter(this);
		this.tools = this._container.resolve('ToolRegistry');
		this.skills = this._container.resolve('SkillRegistry');
		this.config = this._config;

		// Always include the sequential thinking tool
		this.tools.add(SEQUENTIAL_THINKING_TOOL);

		// Initialize watchers if enabled
		if (options.enableWatcher) {
			this._skillWatcher = new SkillWatcher(this.skills, this._logger, this.config.skillDirs);
			this._toolWatcher = new ToolWatcher(this.tools, this._logger, this.config.toolDirs);
		}
	}

	/**
	 * Shared core logic for container creation.
	 * This method contains all common initialization logic between sync and async paths.
	 */
	private static _createContainerCore(
		options: ServerOptions,
		fileConfig: ConfigFileOptions | null,
		persistence: PersistenceBackend | null
	): Container {
		const container = new Container();
		const metrics = new Metrics({
			prefix: 'sequentialthinking',
		});

		const config = ToolAwareSequentialThinkingServer._resolveEffectiveConfig(options, fileConfig);

		// Initialize logger
		const logger =
			options.logger ??
			new StructuredLogger({
				level: fileConfig?.logLevel ?? 'info',
				context: 'SequentialThinking',
				pretty: fileConfig?.prettyLog ?? true,
			});

		// Register all services in the container
		container.registerInstance('Logger', logger);
		container.registerInstance('Config', config);
		container.registerInstance('FileConfig', fileConfig || {});
		container.registerInstance('Persistence', persistence);
		container.registerInstance('Metrics', metrics);
		ToolAwareSequentialThinkingServer._registerDiscoveryRegistries(
			container,
			options.lazyDiscovery
		);

		// Register EdgeStore as a lazy singleton (always registered; flag gates writes)
		container.register('EdgeStore', () => new EdgeStore());

		// Register SummaryStore as a lazy singleton (always registered; flag gates writes)
		container.register('summaryStore', () => new InMemorySummaryStore());

		// Register SuspensionStore as a lazy singleton (only when toolInterleave flag is on)
		if (config.features.toolInterleave) {
			container.register('suspensionStore', () => {
				const store = new InMemorySuspensionStore({
					ttlMs: config.toolInterleaveTtlMs,
					sweepIntervalMs: config.toolInterleaveSweepMs,
					logger,
				});
				store.start();
				return store;
			});
		}

		// Register CompressionService as a lazy singleton (always registered; flag gates invocation)
		container.register('compressionService', () => {
			const historyManager = container.resolve('HistoryManager');
			const edgeStore = container.resolve('EdgeStore');
			const summaryStore = container.resolve('summaryStore');
			const log = container.resolve('Logger');
			return new CompressionService({
				historyManager,
				edgeStore,
				summaryStore,
				onSummaryCreated: (summary) => {
					historyManager.bufferSummaries(
						summary.sessionId,
						summaryStore.forSession(summary.sessionId)
					);
				},
				logger: log,
			});
		});

		// Register ReasoningStrategy as a lazy singleton (selected via feature flag)
		container.register('reasoningStrategy', () =>
			createReasoningStrategy(config.features.reasoningStrategy)
		);

		// Register SessionLock as a lazy singleton (always registered;
		// serializes ThoughtProcessor.process() per-session).
		container.register('sessionLock', () => new SessionLock());
		container.register('sessionLifecycle', () => new SessionLifecycleCoordinator());

		ToolAwareSequentialThinkingServer._registerHistoryManager(container);
		ToolAwareSequentialThinkingServer._registerThoughtPipeline(container, config);

		return container;
	}

	private static _resolveEffectiveConfig(
		options: ServerOptions,
		fileConfig: ConfigFileOptions | null
	): ServerConfig {
		if (options.config) return options.config;
		const loadedOptions = new ConfigLoader().toServerConfigOptions(fileConfig ?? {});
		return new ServerConfig({
			...loadedOptions,
			maxHistorySize: options.maxHistorySize ?? loadedOptions.maxHistorySize,
			maxBranches: options.maxBranches ?? loadedOptions.maxBranches,
			maxBranchSize: options.maxBranchSize ?? loadedOptions.maxBranchSize,
		});
	}

	private static _registerDiscoveryRegistries(
		container: Container,
		lazyDiscovery: ServerOptions['lazyDiscovery']
	): void {
		const logger = container.resolve('Logger');
		const config = container.resolve('Config');
		const metrics = container.resolve('Metrics');

		container.register(
			'ToolRegistry',
			() =>
				new ToolRegistry({
					logger,
					cache: config.discoveryCache
						? new DiscoveryCache({ ...config.discoveryCache, metrics })
						: undefined,
					toolDirs: config.toolDirs,
					lazyDiscovery,
				})
		);
		container.register(
			'SkillRegistry',
			() =>
				new SkillRegistry({
					logger,
					cache: config.discoveryCache
						? new DiscoveryCache({ ...config.discoveryCache, metrics })
						: undefined,
					skillDirs: config.skillDirs,
					lazyDiscovery,
				})
		);
	}

	private static _registerHistoryManager(container: Container): void {
		// Register HistoryManager with lazy initialization
		container.register('HistoryManager', () => {
			const cfg = container.resolve('Config');
			const log = container.resolve('Logger');
			const pers = container.resolve('Persistence');
			const componentMetrics = container.resolve('Metrics');
			const edgeStore = container.resolve('EdgeStore');
			const summaryStore = container.resolve('summaryStore');
			return new HistoryManager({
				maxHistorySize: cfg.maxHistorySize,
				maxBranches: cfg.maxBranches,
				maxBranchSize: cfg.maxBranchSize,
				logger: log,
				persistence: pers,
				metrics: componentMetrics,
				persistenceBufferSize: cfg.persistenceBufferSize,
				persistenceFlushInterval: cfg.persistenceFlushInterval,
				persistenceMaxRetries: cfg.persistenceMaxRetries,
				persistenceHistorySize:
					cfg.persistence.options?.maxHistorySize ?? ABSOLUTE_MAX_HISTORY_SIZE,
				persistBranches: cfg.persistence.options?.persistBranches ?? true,
				edgeStore,
				summaryStore,
				dagEdges: cfg.features.dagEdges,
				maxSessionsPerOwner: cfg.maxSessionsPerOwner,
				sessionLock: container.resolve('sessionLock'),
				lifecycleCoordinator: container.resolve('sessionLifecycle'),
				clearSessionAuxiliaryState: (sessionId) =>
					container.resolve('ThoughtProcessor').clearSessionAuxiliaryState(sessionId),
				clearAllAuxiliaryState: () =>
					container.resolve('ThoughtProcessor').clearAllAuxiliaryState(),
			});
		});
	}

	private static _registerThoughtPipeline(container: Container, config: ServerConfig): void {
		// Register ThoughtFormatter (can be transient)
		container.registerFactory('ThoughtFormatter', () => new ThoughtFormatter());

		// Register OutcomeRecorder as a lazy singleton (gated by feature flag)
		container.register(
			'outcomeRecorder',
			() => new OutcomeRecorder({ enabled: config.features.outcomeRecording ?? false })
		);

		// Register Calibrator as a lazy singleton (gated by feature flag)
		container.register(
			'calibrator',
			() =>
				new Calibrator(container.resolve('outcomeRecorder'), config.features.calibration ?? false)
		);

		// Register ThoughtEvaluator (stateless, transient) with injected calibrator
		container.registerFactory(
			'ThoughtEvaluator',
			() => new ThoughtEvaluator(container.resolve('calibrator'))
		);

		// Register ThoughtProcessor
		container.register('ThoughtProcessor', () => {
			const history = container.resolve('HistoryManager');
			const formatter = container.resolve('ThoughtFormatter');
			const evaluator = container.resolve('ThoughtEvaluator');
			const log = container.resolve('Logger');
			const strategy = container.resolve('reasoningStrategy');
			const compressionService = config.features.compression
				? container.resolve('compressionService')
				: undefined;
			const suspensionStore = config.features.toolInterleave
				? container.resolve('suspensionStore')
				: undefined;
			const toolRegistry = container.resolve('ToolRegistry');
			const sessionLock = container.resolve('sessionLock');
			return new ThoughtProcessor(
				history,
				formatter,
				evaluator,
				log,
				strategy,
				compressionService,
				suspensionStore,
				toolRegistry,
				config.features,
				sessionLock,
				container.resolve('outcomeRecorder'),
				container.resolve('sessionLifecycle'),
				container.resolve('calibrator')
			);
		});
	}

	/**
	 * Create and configure the DI container with async persistence initialization.
	 * This is used internally by the static create() factory.
	 */
	private static async _createContainerAsyncStatic(options: ServerOptions): Promise<Container> {
		let fileConfig: ConfigFileOptions | null;
		let config: ServerConfig;
		if (options.config) {
			fileConfig = options.fileConfig ?? null;
			config = options.config;
		} else {
			const configLoader = new ConfigLoader();
			fileConfig =
				options.fileConfig === undefined
					? configLoader.load()
					: configLoader.applyEnvironmentOverrides(options.fileConfig);
			config = ToolAwareSequentialThinkingServer._resolveEffectiveConfig(options, fileConfig);
		}

		let persistence: PersistenceBackend | null = null;
		try {
			persistence = await createPersistenceBackend(config.persistence);
			return ToolAwareSequentialThinkingServer._createContainerCore(
				{ ...options, config },
				fileConfig,
				persistence
			);
		} catch (error) {
			const acquiredPersistence = persistence;
			const cleanupFailures =
				acquiredPersistence === null
					? []
					: await collectCleanupFailures([() => acquiredPersistence.close()]);
			if (cleanupFailures.length > 0) {
				throw new AggregateError(
					[error, ...cleanupFailures],
					'Container construction failed and cleanup also failed',
					{ cause: error }
				);
			}
			throw error;
		}
	}

	/**
	 * Get the DI container used by this server
	 * Useful for testing and advanced customizations
	 */
	public getContainer(): Container {
		return this._container;
	}

	/**
	 * Discover skills asynchronously without blocking server startup.
	 * This is the recommended method for skill discovery.
	 * @returns Promise<number> - The number of skills discovered
	 */
	public async discoverSkillsAsync(): Promise<number> {
		const discovered = await this.skills.discoverAsync();
		return discovered;
	}

	/** Rescan configured tool and skill directories. */
	public refreshDiscovery(): Promise<{ tools: number; skills: number }> {
		if (!this._acceptingDiscoveryRefreshes) {
			return Promise.reject(new SessionLifecycleClosedError(undefined, 'shutting_down'));
		}
		if (this._refreshPromise !== null) return this._refreshPromise;

		const refreshPromise = Promise.allSettled([
			this.tools.refreshAsync(),
			this.skills.refreshAsync(),
		]).then(([toolResult, skillResult]) => {
			if (toolResult.status === 'rejected') {
				if (skillResult.status === 'rejected') {
					throw new AggregateError(
						[toolResult.reason, skillResult.reason],
						'Failed to refresh tool and skill discovery'
					);
				}
				throw toolResult.reason;
			}
			if (skillResult.status === 'rejected') throw skillResult.reason;
			return { tools: toolResult.value, skills: skillResult.value };
		});
		this._refreshPromise = refreshPromise;
		const clearRefreshPromise = (): void => {
			if (this._refreshPromise === refreshPromise) this._refreshPromise = null;
		};
		void refreshPromise.then(clearRefreshPromise, clearRefreshPromise);
		return refreshPromise;
	}

	/**
	 * Get all branches for one explicit thought session.
	 * @param sessionId - Valid thought-session identifier
	 * @returns Record<string, ThoughtData[]> - Map of branch IDs to thought arrays
	 */
	public getBranches(sessionId: string): Record<BranchId, ThoughtData[]> {
		return this._historyManager.getBranches(asSessionId(sessionId));
	}

	// Main processing method - delegate to ThoughtProcessor
	public async processThought(input: v.InferInput<typeof SequentialThinkingSchema>) {
		const startTime = Date.now();
		const result = await this._thoughtProcessor.process(input as ThoughtData);
		const durationSeconds = (Date.now() - startTime) / 1000;
		this._metrics.histogram('thought_processing_duration_seconds', durationSeconds, {});
		return result;
	}

	public getMetricsSnapshot(): string {
		return this._metrics.export();
	}

	/**
	 * Stop the server and clean up watchers.
	 * Closes persistence backend gracefully to ensure data is flushed.
	 */
	public stop(): Promise<void> {
		this._acceptingDiscoveryRefreshes = false;
		if (this._stopPromise) return this._stopPromise;
		const acceptedRefresh = this._refreshPromise;
		this._stopPromise = this._container.resolve('sessionLifecycle').shutdown(async () => {
			const failures: unknown[] = [];
			const [skillWatcherResult, toolWatcherResult, refreshResult] = await Promise.allSettled([
				this._skillWatcher?.stop() ?? Promise.resolve(),
				this._toolWatcher?.stop() ?? Promise.resolve(),
				acceptedRefresh ?? Promise.resolve(),
			]);
			for (const result of [skillWatcherResult, toolWatcherResult]) {
				switch (result.status) {
					case 'fulfilled':
						break;
					case 'rejected':
						appendCleanupFailure(failures, result.reason);
						this._logger.error('Error stopping watcher', {
							error: getErrorMessage(result.reason),
						});
						break;
					default:
						assertNever(result);
				}
			}
			switch (refreshResult.status) {
				case 'fulfilled':
					break;
				case 'rejected':
					appendCleanupFailure(failures, refreshResult.reason);
					this._logger.error('Error refreshing discovery during shutdown', {
						error: getErrorMessage(refreshResult.reason),
					});
					break;
				default:
					assertNever(refreshResult);
			}

			// Stop suspension store sweeper if registered
			if (this._config.features.toolInterleave && this._container.has('suspensionStore')) {
				try {
					const suspensionStore = this._container.resolve('suspensionStore');
					suspensionStore.stop();
				} catch (error) {
					appendCleanupFailure(failures, error);
					this._logger.error('Error stopping suspension store', {
						error: getErrorMessage(error),
					});
				}
			}

			// Flush any buffered writes before closing persistence
			try {
				await this._historyManager.shutdownWithinLifecycle();
			} catch (error) {
				appendCleanupFailure(failures, error);
				this._logger.error('Error flushing write buffer during shutdown', {
					error: getErrorMessage(error),
				});
			}

			// Close persistence backend if available
			const persistence = this._container.resolve('Persistence');
			if (persistence) {
				try {
					await persistence.close();
					this._logger.info('Persistence backend closed');
				} catch (error) {
					appendCleanupFailure(failures, error);
					this._logger.error('Error closing persistence backend', {
						error: getErrorMessage(error),
					});
				}
			}

			if (failures.length > 0) {
				throw new AggregateError(failures, 'Failed to stop server cleanly');
			}
			this._historyManager.clearLiveStateAfterShutdown();
			this._logger.info('Server stopped, watchers cleaned up');
		});
		return this._stopPromise;
	}

	/** Awaitably resets one session and matching processor-owned state. */
	public async resetSession(sessionId: string): Promise<void> {
		await this._thoughtProcessor.resetSession(sessionId);
		this._logger.info('Server session reset', { sessionId });
	}

	/** Awaitably resets all server state from a trusted ownerless context. */
	public async resetAll(): Promise<void> {
		await this._thoughtProcessor.resetAll();
		this._logger.info('All server sessions reset');
	}

	/**
	 * Dispose of the server and all container services.
	 * Implements the IDisposable interface.
	 * Calls stop() for existing cleanup, then disposes the DI container.
	 */
	public dispose(): Promise<void> {
		if (this._disposePromise) return this._disposePromise;
		this._disposePromise = (async () => {
			const failures = await collectCleanupFailures([
				() => this.stop(),
				() => this._container.dispose(),
			]);
			if (failures.length > 0) {
				throw new AggregateError(failures, 'Failed to dispose server cleanly');
			}
			this._logger.info('Server disposed, all resources released');
		})();
		return this._disposePromise;
	}
}

/**
 * Factory function to create a new server instance with async initialization.
 *
 * This is the recommended way to create server instances, especially for testing,
 * as it allows for proper async initialization, dependency injection, and persistence.
 *
 * @param options - Server configuration options
 * @returns A Promise that resolves to a configured server instance
 *
 * @example
 * ```typescript
 * import { createServer } from '@iworkforces/tracelattice';
 *
 * // Basic usage (with async discovery and persistence)
 * const server = await createServer();
 *
 * // With custom options
 * const server = await createServer({
 *   autoDiscover: false,
 *   lazyDiscovery: true,
 *   maxHistorySize: 500,
 *   loadFromPersistence: true
 * });
 * ```
 */
export async function createServer(
	options: ServerOptions = {}
): Promise<ToolAwareSequentialThinkingServer> {
	return ToolAwareSequentialThinkingServer.create(options);
}

// Initialize server
export async function initializeServer(): Promise<ToolAwareSequentialThinkingServer> {
	// Create logger for initialization
	const configLoader = new ConfigLoader();
	const fileConfig = configLoader.load() ?? {};
	const config = new ServerConfig(configLoader.toServerConfigOptions(fileConfig));

	const logger = new StructuredLogger({
		level: fileConfig.logLevel ?? 'info',
		context: 'SequentialThinking',
		pretty: fileConfig.prettyLog ?? true,
	});

	// Create server instance
	const thinkingServer = await createServer({
		logger,
		enableWatcher: true,
		config,
		fileConfig,
	});

	logger.info('Server initialized successfully');
	return thinkingServer;
}
