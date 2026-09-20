import { loadBaseline, loadOverrides } from './baseline.js';
import { computeCategoryResult } from './calculator.js';
import { CATEGORY_GATES, evaluateGate, isOverrideActive } from './gates.js';
import { BATTLE_SCENARIOS } from './scenarios/all.js';
import { runScenarios } from './scenarios/types.js';
import { CATEGORY_NAMES } from './types.js';

import type { BattleScenario } from './scenarios/types.js';
import type {
	ApprovedOverride,
	BaselineCaseScore,
	BattleTestReport,
	CaseDrop,
	CaseScore,
	Category,
	CategoryResult,
	CriticalFailureKind,
} from './types.js';

export type RunBattleTestOptions = {
	readonly baselinePath?: string;
	readonly overridesPath?: string;
	readonly scenarios?: readonly BattleScenario[];
	readonly runId?: string;
	readonly runTimestamp?: string;
	readonly now?: Date;
};

export async function runBattleTest(options: RunBattleTestOptions = {}): Promise<BattleTestReport> {
	const baseline = loadBaseline(options.baselinePath);
	const overrides = loadOverrides(options.overridesPath);
	const now = options.now ?? new Date();
	const approvedOverrides = activeOverrides(overrides, now);
	const scores = await runScenarios(options.scenarios ?? BATTLE_SCENARIOS);
	const scoresByCategory = groupScoresByCategory(scores);

	const categories = CATEGORY_NAMES.map((category) =>
		evaluateGate(
			computeCategoryResult({
				category,
				cases: scoresByCategory.get(category) ?? [],
				baselineAverage: baseline.categoryAverages[category],
				baselineCases: baselineCasesForCategory(baseline.caseScores ?? [], category),
				gate: CATEGORY_GATES[category],
			}),
			approvedOverrides,
			now
		)
	);
	const blockedCategories = categories
		.filter((categoryResult) => categoryResult.status === 'blocked')
		.map((categoryResult) => categoryResult.category);
	const runTimestamp = options.runTimestamp ?? now.toISOString();

	return {
		runId: options.runId ?? `battle-test-${runTimestamp}`,
		runTimestamp,
		overallStatus: blockedCategories.length > 0 ? 'blocked' : 'pass',
		baseline,
		categories,
		criticalFailures: mergedCriticalFailures(categories),
		largestDrops: largestDrops(categories),
		blockedCategories,
		approvedOverrides,
	};
}

function groupScoresByCategory(
	scores: readonly CaseScore[]
): ReadonlyMap<Category, readonly CaseScore[]> {
	const scoresByCategory = new Map<Category, CaseScore[]>();

	for (const score of scores) {
		const categoryScores = scoresByCategory.get(score.category) ?? [];
		categoryScores.push(score);
		scoresByCategory.set(score.category, categoryScores);
	}

	return scoresByCategory;
}

function baselineCasesForCategory(
	caseScores: readonly BaselineCaseScore[],
	category: Category
): readonly BaselineCaseScore[] {
	return caseScores.filter((caseScore) => caseScore.category === category);
}

function activeOverrides(
	overrides: readonly ApprovedOverride[],
	now: Date
): readonly ApprovedOverride[] {
	return overrides.filter((override) => isOverrideActive(override, now));
}

function mergedCriticalFailures(
	categories: readonly CategoryResult[]
): readonly CriticalFailureKind[] {
	const criticalFailures: CriticalFailureKind[] = [];

	for (const criticalFailure of categories.flatMap((category) => category.criticalFailures)) {
		if (!criticalFailures.includes(criticalFailure)) {
			criticalFailures.push(criticalFailure);
		}
	}

	return criticalFailures;
}

function largestDrops(categories: readonly CategoryResult[]): readonly CaseDrop[] {
	return categories
		.flatMap((category) => category.largestDrops)
		.toSorted((left, right) => right.drop - left.drop || left.caseId.localeCompare(right.caseId));
}
