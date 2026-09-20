import { describe, it, expect } from 'vitest';
import { HistoryManager } from '../../core/HistoryManager.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import type { ThoughtData } from '../../core/thought.js';
import { asSessionId, asThoughtId, asSuspensionToken } from '../../contracts/ids.js';

const SESSION = asSessionId('tool-invocation-session');

function toolCallThought(overrides: Partial<ThoughtData> = {}): ThoughtData {
	return {
		thought: 'invoke',
		thought_number: 1,
		total_thoughts: 2,
		next_thought_needed: true,
		thought_type: 'tool_call',
		session_id: SESSION,
		tool_name: 'search',
		tool_arguments: { q: 'foo' },
		id: asThoughtId('tc-id-1'),
		...overrides,
	};
}

function toolObservationThought(overrides: Partial<ThoughtData> = {}): ThoughtData {
	return {
		thought: 'observed',
		thought_number: 2,
		total_thoughts: 2,
		next_thought_needed: false,
		thought_type: 'tool_observation',
		session_id: SESSION,
		continuation_token: asSuspensionToken('tok'),
		id: asThoughtId('to-id-1'),
		...overrides,
	};
}

describe('HistoryManager — tool_invocation edge emission', () => {
	it('emits a tool_invocation edge from tool_call to tool_observation when both flags are set', () => {
		const edgeStore = new EdgeStore();
		const hm = new HistoryManager({ edgeStore, dagEdges: true });
		hm.addThought(toolCallThought());
		hm.addThought(toolObservationThought({ tool_name: 'search' }), {
			toolInvocationSourceThoughtId: asThoughtId('tc-id-1'),
		});
		const outs = edgeStore.outgoing(SESSION, 'tc-id-1');
		const toolEdge = outs.find((e) => e.kind === 'tool_invocation');
		expect(toolEdge).toBeDefined();
		expect(toolEdge?.from).toBe('tc-id-1');
		expect(toolEdge?.to).toBe('to-id-1');
		expect(toolEdge?.metadata).toEqual({ tool_name: 'search' });
	});

	it('omits metadata.tool_name when the observation thought has no tool_name', () => {
		const edgeStore = new EdgeStore();
		const hm = new HistoryManager({ edgeStore, dagEdges: true });
		hm.addThought(toolCallThought());
		// Pass observation without tool_name; cast preserves type narrowing for the test.
		const obs = toolObservationThought();
		delete (obs as Partial<ThoughtData>).tool_name;
		hm.addThought(obs, { toolInvocationSourceThoughtId: asThoughtId('tc-id-1') });
		const outs = edgeStore.outgoing(SESSION, 'tc-id-1');
		const toolEdge = outs.find((e) => e.kind === 'tool_invocation');
		expect(toolEdge).toBeDefined();
		expect(toolEdge?.metadata).toBeUndefined();
	});

	it('does NOT emit any edges when dagEdges flag is OFF', () => {
		const edgeStore = new EdgeStore();
		const hm = new HistoryManager({ edgeStore, dagEdges: false });
		hm.addThought(toolCallThought());
		hm.addThought(toolObservationThought({ tool_name: 'search' }), {
			toolInvocationSourceThoughtId: asThoughtId('tc-id-1'),
		});
		expect(edgeStore.size(SESSION)).toBe(0);
	});

	it('does NOT emit a tool_invocation edge when the observation thought has no id', () => {
		const edgeStore = new EdgeStore();
		const hm = new HistoryManager({ edgeStore, dagEdges: true });
		hm.addThought(toolCallThought());
		const obs = toolObservationThought({ tool_name: 'search' });
		delete (obs as Partial<ThoughtData>).id;
		hm.addThought(obs, { toolInvocationSourceThoughtId: asThoughtId('tc-id-1') });
		// No edges referencing the (now id-less) observation should exist.
		const outs = edgeStore.outgoing(SESSION, 'tc-id-1');
		expect(outs.find((e) => e.kind === 'tool_invocation')).toBeUndefined();
	});

	it('falls back to a sequence edge when stable admission context is absent', () => {
		const edgeStore = new EdgeStore();
		const hm = new HistoryManager({ edgeStore, dagEdges: true });
		hm.addThought(toolCallThought());
		const obs = toolObservationThought({ tool_name: 'search' });
		hm.addThought(obs);
		const outs = edgeStore.outgoing(SESSION, 'tc-id-1');
		expect(outs.find((e) => e.kind === 'tool_invocation')).toBeUndefined();
		expect(outs.find((e) => e.kind === 'sequence')).toBeDefined();
	});
});
