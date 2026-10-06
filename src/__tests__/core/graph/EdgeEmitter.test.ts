import { describe, expect, it, vi } from 'vitest';
import { EdgeEmitter } from '../../../core/graph/EdgeEmitter.js';
import { EdgeStore } from '../../../core/graph/EdgeStore.js';
import {
	createTestSessionId,
	createTestThoughtId,
	createTestThought,
} from '../../helpers/factories.js';

describe('EdgeEmitter deduplication', () => {
	it('adds a relational edge once and returns false on repeated emission', () => {
		const sessionId = createTestSessionId();
		const sourceId = createTestThoughtId('source');
		const thought = createTestThought({
			id: createTestThoughtId('current'),
			session_id: sessionId,
			synthesis_sources: [1],
		});
		const store = new EdgeStore();
		const emitter = new EdgeEmitter({ edgeStore: store, dagEdges: true });
		const addEdge = vi.spyOn(store, 'addEdge');
		const session = { thought_history: [thought], branches: {} };
		const context = { resolvedReferences: { synthesisSourceThoughtIds: [sourceId] } };

		expect(emitter.emitEdgesForThought(session, thought, context)).toBe(true);
		expect(emitter.emitEdgesForThought(session, thought, context)).toBe(false);
		expect(store.edgesForSession(sessionId)).toHaveLength(1);
		expect(addEdge).toHaveBeenCalledTimes(1);
	});
});
