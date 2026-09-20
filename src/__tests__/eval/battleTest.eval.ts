import { describe, it } from 'vitest';

import { toJsonLine, toSummaryJsonLine } from './battleTest/reporter.js';
import { runBattleTest } from './battleTest/runner.js';

class BattleTestBlockedError extends Error {
	override readonly name = 'BattleTestBlockedError';

	constructor(readonly blockedCategories: readonly string[]) {
		super(`Battle test blocked categories: ${blockedCategories.join(', ')}`);
	}
}

describe.skipIf(!process.env.RUN_EVAL)('Battle Test', () => {
	it('runs category regression gates', async () => {
		const report = await runBattleTest();

		for (const category of report.categories) {
			console.log(toJsonLine(category));
		}

		console.log(toSummaryJsonLine(report));

		if (report.overallStatus === 'blocked') {
			throw new BattleTestBlockedError(report.blockedCategories);
		}
	});
});
