import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runBattleTest } from './runner.js';
import { CATEGORY_NAMES } from './types.js';

import type {
	ApprovedOverride,
	BaselineCaseScore,
	BaselineRecord,
	CaseScore,
	Category,
} from './types.js';
import type { BattleScenario } from './scenarios/types.js';

const NOW = new Date('2026-06-26T12:00:00.000Z');
const RUN_ID = 'battle-test-runner-test';
const RUN_TIMESTAMP = '2026-06-26T12:00:00.000Z';

type BaselineOptions = {
	readonly category: Category;
	readonly baselineAverage: number;
	readonly caseScores?: readonly BaselineCaseScore[];
};

function createCategoryAverages(
	category: Category,
	baselineAverage: number
): BaselineRecord['categoryAverages'] {
	return {
		'adversarial-prompts': category === 'adversarial-prompts' ? baselineAverage : 0,
		'long-horizon-tasks': category === 'long-horizon-tasks' ? baselineAverage : 0,
		'branching-revision-merge-backtrack':
			category === 'branching-revision-merge-backtrack' ? baselineAverage : 0,
		'hypothesis-and-verification': category === 'hypothesis-and-verification' ? baselineAverage : 0,
		'tool-recommendation-quality': category === 'tool-recommendation-quality' ? baselineAverage : 0,
		'skill-recommendation-quality':
			category === 'skill-recommendation-quality' ? baselineAverage : 0,
		'state-isolation-and-reset': category === 'state-isolation-and-reset' ? baselineAverage : 0,
		'malformed-and-edge-inputs': category === 'malformed-and-edge-inputs' ? baselineAverage : 0,
		'reasoning-hints-and-confidence':
			category === 'reasoning-hints-and-confidence' ? baselineAverage : 0,
		'final-answer-consistency': category === 'final-answer-consistency' ? baselineAverage : 0,
		'regression-anchors-and-calibration':
			category === 'regression-anchors-and-calibration' ? baselineAverage : 0,
	};
}

function createBaseline(options: BaselineOptions): BaselineRecord {
	return {
		version: '1.4.4',
		approvedAt: '2026-06-26T00:00:00.000Z',
		categoryAverages: createCategoryAverages(options.category, options.baselineAverage),
		...(options.caseScores === undefined ? {} : { caseScores: options.caseScores }),
	};
}

function writeJsonFixture(fileName: string, value: unknown): string {
	const directory = mkdtempSync(join(tmpdir(), 'tracelattice-battle-runner-'));
	const path = join(directory, fileName);
	writeFileSync(path, JSON.stringify(value), 'utf8');
	return path;
}

function createCaseScore(overrides: Partial<CaseScore> = {}): CaseScore {
	return {
		caseId: 'synthetic-case',
		category: 'adversarial-prompts',
		score: 100,
		deterministic: true,
		...overrides,
	};
}

function createScenario(caseScore: CaseScore): BattleScenario {
	return {
		caseId: caseScore.caseId,
		category: caseScore.category,
		description: `Synthetic ${caseScore.caseId}`,
		run: () => caseScore,
	};
}

function runWithFixture(
	baseline: BaselineRecord,
	scenarios: readonly BattleScenario[],
	overrides: readonly ApprovedOverride[] = []
) {
	return runBattleTest({
		baselinePath: writeJsonFixture('baseline.json', baseline),
		overridesPath: writeJsonFixture('overrides.json', overrides),
		scenarios,
		runId: RUN_ID,
		runTimestamp: RUN_TIMESTAMP,
		now: NOW,
	});
}

describe('runBattleTest', () => {
	it('blocks the run when a synthetic category drop exceeds five points', async () => {
		// Given
		const category: Category = 'adversarial-prompts';
		const caseScore = createCaseScore({ category, score: 94, caseId: 'adversarial-drop' });
		const baseline = createBaseline({
			category,
			baselineAverage: 100,
			caseScores: [{ category, caseId: caseScore.caseId, score: 100 }],
		});

		// When
		const report = await runWithFixture(baseline, [createScenario(caseScore)]);

		// Then
		expect(report.overallStatus).toBe('blocked');
		expect(report.blockedCategories).toEqual([category]);
		expect(report.categories.find((result) => result.category === category)?.drop).toBe(6);
	});

	it('blocks a critical failure even when the category average would pass', async () => {
		// Given
		const category: Category = 'state-isolation-and-reset';
		const caseScore = createCaseScore({
			category,
			score: 100,
			caseId: 'state-critical',
			criticalFailure: 'cross-session-leakage',
		});
		const baseline = createBaseline({ category, baselineAverage: 100 });

		// When
		const report = await runWithFixture(baseline, [createScenario(caseScore)]);

		// Then
		expect(report.overallStatus).toBe('blocked');
		expect(report.blockedCategories).toEqual([category]);
		expect(report.criticalFailures).toEqual(['cross-session-leakage']);
	});

	it('downgrades an approved standard block without suppressing critical failures', async () => {
		// Given
		const category: Category = 'tool-recommendation-quality';
		const standardDrop = createCaseScore({ category, score: 94, caseId: 'tool-drop' });
		const criticalFailure = createCaseScore({
			category: 'malformed-and-edge-inputs',
			score: 100,
			caseId: 'malformed-critical',
			criticalFailure: 'malformed-input-crash',
		});
		const override: ApprovedOverride = {
			category,
			approvedAt: '2026-06-26T00:00:00.000Z',
			reason: 'Known deterministic tool scoring drop under review.',
			owner: 'eval-owner',
			expiresAt: '2026-06-27T00:00:00.000Z',
		};
		const criticalOverride: ApprovedOverride = {
			...override,
			category: 'malformed-and-edge-inputs',
		};
		const standardReport = await runWithFixture(
			createBaseline({ category, baselineAverage: 100 }),
			[createScenario(standardDrop)],
			[override]
		);

		// When
		const criticalReport = await runWithFixture(
			createBaseline({ category: 'malformed-and-edge-inputs', baselineAverage: 100 }),
			[createScenario(criticalFailure)],
			[criticalOverride]
		);

		// Then
		expect(standardReport.overallStatus).toBe('pass');
		expect(standardReport.blockedCategories).toEqual([]);
		expect(standardReport.categories.find((result) => result.category === category)?.status).toBe(
			'review'
		);
		expect(standardReport.approvedOverrides).toEqual([override]);
		expect(criticalReport.overallStatus).toBe('blocked');
		expect(criticalReport.criticalFailures).toEqual(['malformed-input-crash']);
	});

	it('passes the default scenario catalog against the seeded baseline', async () => {
		// Given / When
		const report = await runBattleTest({ runId: RUN_ID, runTimestamp: RUN_TIMESTAMP, now: NOW });

		// Then
		expect(report.overallStatus).toBe('pass');
		expect(report.blockedCategories).toEqual([]);
		expect(report.categories.map((result) => result.category)).toEqual(CATEGORY_NAMES);
		expect(report.categories.every((result) => result.cases.length === 3)).toBe(true);
	});
});
