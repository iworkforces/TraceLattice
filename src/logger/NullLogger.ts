/**
 * Null logger that discards all log messages.
 *
 * This logger implements the same interface as `StructuredLogger` but
 * silently discards all log messages. It's useful as a default/fallback
 * logger when logging is disabled or when no logger is provided.
 *
 * @module logger
 */

import type { LogLevel, Logger, LoggerOptions } from './StructuredLogger.js';

/**
 * Null logger that discards all log messages.
 *
 * This class provides a no-op implementation of the logger interface.
 * All method calls are silent and have no effect, making it suitable
 * for use as a default logger when logging is disabled or not needed.
 *
 * @remarks
 * The `NullLogger` implements the same interface as `StructuredLogger`,
 * making them interchangeable. Use `NullLogger` when:
 * - You want to disable logging completely
 * - You need a logger placeholder that can be swapped later
 * - Testing components that don't need output
 * - Reducing overhead in performance-critical sections
 *
 * @example
 * ```typescript
 * import { NullLogger } from './logger/index.js';
 *
 * // Create a null logger
 * const logger = new NullLogger();
 *
 * // All log calls are silently discarded
 * logger.debug('This will not appear');
 * logger.info('Nor will this');
 * logger.warn('Or this warning');
 * logger.error('Or even this error');
 *
 * logger.setLevel('debug');
 * const level = logger.getLevel(); // Returns 'error' (default)
 * ```
 */
export class NullLogger implements Logger {
	/**
	 * Current minimum log level.
	 *
	 * @remarks
	 * Since all messages are discarded, the level setting has no practical
	 * effect. The value is retained to satisfy the logger contract.
	 * @private
	 */
	private _level: LogLevel;

	/**
	 * Creates a new NullLogger instance.
	 *
	 * @param options - Configuration options used to initialize the logger contract
	 *
	 * @example
	 * ```typescript
	 * // Create a null logger
	 * const logger1 = new NullLogger();
	 *
	 * // With options (ignored)
	 * const logger2 = new NullLogger({
	 *   level: 'debug',
	 *   context: 'MyApp',
	 *   pretty: true
	 * });
	 * ```
	 */
	constructor(options: LoggerOptions = {}) {
		this._level = options.level ?? 'error';
	}

	/**
	 * Log a debug message (no-op).
	 *
	 * This logger discards the message.
	 *
	 * @param _message - Ignored
	 * @param _meta - Ignored
	 */
	debug(_message: string, _meta?: Record<string, unknown>): void {}

	/**
	 * Log an info message (no-op).
	 *
	 * This logger discards the message.
	 *
	 * @param _message - Ignored
	 * @param _meta - Ignored
	 */
	info(_message: string, _meta?: Record<string, unknown>): void {}

	/**
	 * Log a warning message (no-op).
	 *
	 * This logger discards the message.
	 *
	 * @param _message - Ignored
	 * @param _meta - Ignored
	 */
	warn(_message: string, _meta?: Record<string, unknown>): void {}

	/**
	 * Log an error message (no-op).
	 *
	 * This logger discards the message.
	 *
	 * @param _message - Ignored
	 * @param _meta - Ignored
	 */
	error(_message: string, _meta?: Record<string, unknown>): void {}

	/**
	 * Sets the minimum log level (no-op).
	 *
	 * The level is retained for `getLevel` and child loggers, but does not
	 * affect output because all messages are discarded.
	 *
	 * @param level - The new minimum log level (ignored)
	 *
	 * @example
	 * ```typescript
	 * logger.setLevel('debug');  // No effect
	 * ```
	 */
	setLevel(level: LogLevel): void {
		this._level = level;
	}

	/**
	 * Gets the current minimum log level.
	 *
	 * @returns The current log level (stored value, unused)
	 *
	 * @example
	 * ```typescript
	 * const currentLevel = logger.getLevel();
	 * console.log(`Current level: ${currentLevel}`); // 'error' by default
	 * ```
	 */
	getLevel(): LogLevel {
		return this._level;
	}

	/**
	 * Creates a child null logger (returns a new NullLogger).
	 *
	 * Returns a new `NullLogger` instance (not a child with extended context) since
	 * context tracking is not applicable for a no-op logger.
	 *
	 * @param _context - Additional context (ignored)
	 * @returns A new NullLogger instance
	 *
	 * @example
	 * ```typescript
	 * const nullLogger = new NullLogger();
	 * const childLogger = nullLogger.createChild('ChildModule');
	 * // childLogger is also a NullLogger
	 * ```
	 */
	createChild(_context: string): NullLogger {
		return new NullLogger({ level: this._level });
	}
}
