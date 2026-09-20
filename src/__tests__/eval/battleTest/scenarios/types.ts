import type { CaseScore, Category } from '../types.js';

export interface BattleScenario {
	readonly caseId: string;
	readonly category: Category;
	readonly description: string;
	run(): CaseScore | Promise<CaseScore>;
}

export async function runScenarios(
	scenarios: readonly BattleScenario[]
): Promise<readonly CaseScore[]> {
	return Promise.all(scenarios.map((scenario) => scenario.run()));
}
