import { vi } from 'vitest';

export function useFakeTimers(): void {
	vi.useFakeTimers({ shouldAdvanceTime: false });
}

export function advanceTime(ms: number): void {
	vi.advanceTimersByTime(ms);
}

export async function advanceTimeAsync(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

export function useRealTimers(): void {
	vi.useRealTimers();
}
