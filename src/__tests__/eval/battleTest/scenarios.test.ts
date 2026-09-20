import { describe, expect, it } from 'vitest';

import { BATTLE_SCENARIOS } from './scenarios/all.js';
import { runScenarios } from './scenarios/types.js';
import { CATEGORY_NAMES } from './types.js';

describe('battle-test scenario catalog', () => {
	it('represents all 11 regression categories', () => {
		// Given
		const expectedCategories = [...CATEGORY_NAMES].sort();

		// When
		const actualCategories = [
			...new Set(BATTLE_SCENARIOS.map((scenario) => scenario.category)),
		].sort();

		// Then
		expect(actualCategories).toEqual(expectedCategories);
	});

	it('contains exactly three deterministic scenarios per category', () => {
		// Given / When
		const categoryCounts = new Map<string, number>();
		for (const scenario of BATTLE_SCENARIOS) {
			categoryCounts.set(scenario.category, (categoryCounts.get(scenario.category) ?? 0) + 1);
		}

		// Then
		expect(BATTLE_SCENARIOS).toHaveLength(33);
		expect([...CATEGORY_NAMES].map((category) => categoryCounts.get(category))).toEqual(
			Array.from({ length: CATEGORY_NAMES.length }, () => 3)
		);
	});

	it('uses unique case IDs', () => {
		// Given / When
		const ids = BATTLE_SCENARIOS.map((scenario) => scenario.caseId);

		// Then
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('runs to deterministic CaseScore output', async () => {
		// Given / When
		const firstRun = await runScenarios(BATTLE_SCENARIOS);
		const secondRun = await runScenarios(BATTLE_SCENARIOS);

		// Then
		expect(firstRun).toHaveLength(33);
		expect(secondRun).toEqual(firstRun);
		expect(firstRun.every((caseScore) => caseScore.deterministic)).toBe(true);
		expect(firstRun.every((caseScore) => caseScore.score >= 0 && caseScore.score <= 100)).toBe(
			true
		);
	});

	it('keeps critical-failure-aware state and malformed scenarios green today', async () => {
		// Given
		const scores = await runScenarios(BATTLE_SCENARIOS);
		const stateScores = scores.filter((score) => score.category === 'state-isolation-and-reset');
		const malformedScores = scores.filter(
			(score) => score.category === 'malformed-and-edge-inputs'
		);
		const stateDescriptions = BATTLE_SCENARIOS.filter(
			(scenario) => scenario.category === 'state-isolation-and-reset'
		).map((scenario) => scenario.description);
		const malformedDescriptions = BATTLE_SCENARIOS.filter(
			(scenario) => scenario.category === 'malformed-and-edge-inputs'
		).map((scenario) => scenario.description);

		// When
		const criticalFailures = [...stateScores, ...malformedScores].flatMap((score) =>
			score.criticalFailure === undefined ? [] : [score.criticalFailure]
		);

		// Then
		expect(stateScores).toHaveLength(3);
		expect(malformedScores).toHaveLength(3);
		expect(criticalFailures).toEqual([]);
		expect(stateDescriptions.join('\n')).toContain('cross-session-leakage');
		expect(stateDescriptions.join('\n')).toContain('reset-state-not-clearing');
		expect(malformedDescriptions.join('\n')).toContain('malformed-input-crash');
	});

	it('scores final-answer omissions without critical failures', async () => {
		// Given
		const scores = await runScenarios(BATTLE_SCENARIOS);

		// When
		const omissionScore = scores.find((score) => score.caseId === 'final-answer-scope-trace');

		// Then
		expect(omissionScore).toEqual(
			expect.objectContaining({
				category: 'final-answer-consistency',
			})
		);
		expect(omissionScore?.score).toBeLessThan(100);
		expect(omissionScore?.criticalFailure).toBeUndefined();
	});
});
