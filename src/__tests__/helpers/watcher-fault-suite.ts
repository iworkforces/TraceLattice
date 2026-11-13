import { afterEach, beforeEach, describe, vi } from 'vitest';
import { resetChokidarMock } from './chokidar-mock.js';
import { useFakeTimers, useRealTimers } from './timers.js';
import { describeReplacementBound } from './watcher-fault-replacement.js';
import { describeFaultHandling, describeReady } from './watcher-fault-reporting.js';
import { describeBackoff, describeRestart, describeStop } from './watcher-fault-restart.js';
import type { WatcherSubject } from './watcher-fault-harness.js';

export function describeWatcherFaultRecovery(subject: WatcherSubject): void {
	describe(`${subject.name} fault recovery`, () => {
		beforeEach(() => {
			vi.clearAllMocks();
			resetChokidarMock();
			useFakeTimers();
		});
		afterEach(() => {
			useRealTimers();
			vi.restoreAllMocks();
		});

		describe('fault handling', () => describeFaultHandling(subject));
		describe('restart', () => describeRestart(subject));
		describe('backoff', () => describeBackoff(subject));
		describe('ready', () => describeReady(subject));
		describe('replacement ready bound', () => describeReplacementBound(subject));
		describe('stop', () => describeStop(subject));
	});
}
