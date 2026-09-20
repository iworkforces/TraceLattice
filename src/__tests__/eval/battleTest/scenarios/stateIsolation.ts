import { asSessionId } from '../../../../contracts/ids.js';
import { createTestThought, MockHistoryManager } from '../../../helpers/factories.js';
import { scoreChecks } from './helpers.js';
import type { BattleScenario } from './types.js';

const category = 'state-isolation-and-reset';

export const STATE_ISOLATION_SCENARIOS = [
	{
		caseId: 'state-isolation-history-partitions',
		category,
		description:
			'MockHistoryManager detects cross-session-leakage if histories bleed across sessions.',
		run: () => {
			const history = new MockHistoryManager();
			history.addThought(createTestThought({ thought: 'session a', session_id: 'state-a' }));
			history.addThought(createTestThought({ thought: 'session b', session_id: 'state-b' }));
			const sessionA = history.getHistory('state-a').map((thought) => thought.thought);
			const sessionB = history.getHistory('state-b').map((thought) => thought.thought);
			return scoreChecks({
				caseId: 'state-isolation-history-partitions',
				category,
				checks: {
					sessionAHasOnlyA: sessionA.length === 1 && sessionA.includes('session a'),
					sessionBHasOnlyB: sessionB.length === 1 && sessionB.includes('session b'),
					noCrossLeakage: !sessionA.includes('session b') && !sessionB.includes('session a'),
				},
				criticalFailure: 'cross-session-leakage',
			});
		},
	},
	{
		caseId: 'state-isolation-clear-one-session',
		category,
		description:
			'resetSession(session) detects reset-state-not-clearing if target session remains populated.',
		run: async () => {
			const history = new MockHistoryManager();
			history.addThought(createTestThought({ thought: 'session a', session_id: 'reset-a' }));
			history.addThought(createTestThought({ thought: 'session b', session_id: 'reset-b' }));
			await history.resetSession(asSessionId('reset-a'));
			return scoreChecks({
				caseId: 'state-isolation-clear-one-session',
				category,
				checks: {
					targetCleared: history.getHistoryLength('reset-a') === 0,
					otherSessionPreserved: history.getHistoryLength('reset-b') === 1,
					resetCalledOnce: history.getResetCallCount() === 1,
				},
				criticalFailure: 'reset-state-not-clearing',
			});
		},
	},
	{
		caseId: 'state-isolation-tool-skill-partitions',
		category,
		description: 'Available tool and skill metadata remains scoped to the session that set it.',
		run: () => {
			const history = new MockHistoryManager();
			history.addThought(
				createTestThought({
					session_id: 'meta-a',
					available_mcp_tools: ['Read'],
					available_skills: ['programming'],
				})
			);
			history.addThought(
				createTestThought({
					session_id: 'meta-b',
					available_mcp_tools: ['Bash'],
					available_skills: ['review-work'],
				})
			);
			return scoreChecks({
				caseId: 'state-isolation-tool-skill-partitions',
				category,
				checks: {
					toolsScoped: history.getAvailableMcpTools('meta-a')?.includes('Read') === true,
					skillsScoped: history.getAvailableSkills('meta-b')?.includes('review-work') === true,
					metadataSeparated: history.getAvailableMcpTools('meta-a')?.includes('Bash') === false,
				},
				criticalFailure: 'cross-session-leakage',
			});
		},
	},
] as const satisfies readonly BattleScenario[];
