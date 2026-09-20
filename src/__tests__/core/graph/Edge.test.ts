/**
 * Tests for Edge type schemas and ID generation.
 */

import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { EdgeKindSchema, EdgeSchema } from '../../../schema.js';
import { generateUlid } from '../../../core/ids.js';
import type { EdgeKind } from '../../../core/graph/Edge.js';

const ALL_KINDS: EdgeKind[] = [
	'sequence',
	'branch',
	'merge',
	'verifies',
	'critiques',
	'derives_from',
	'tool_invocation',
	'revises',
];

function validEdge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'edge-1',
		from: 'thought-a',
		to: 'thought-b',
		kind: 'sequence',
		sessionId: 'edge-session',
		createdAt: Date.now(),
		...overrides,
	};
}

describe('EdgeKindSchema', () => {
	it('accepts all 8 kinds', () => {
		for (const kind of ALL_KINDS) {
			const result = v.safeParse(EdgeKindSchema, kind);
			expect(result.success, `kind=${kind} should be accepted`).toBe(true);
		}
	});

	it('rejects unknown kind', () => {
		const result = v.safeParse(EdgeKindSchema, 'unknown');
		expect(result.success).toBe(false);
	});
});

describe('EdgeSchema', () => {
	it('accepts a minimal valid edge with required fields only', () => {
		const result = v.safeParse(EdgeSchema, validEdge());
		expect(result.success).toBe(true);
	});

	it('accepts an edge with optional metadata', () => {
		const result = v.safeParse(
			EdgeSchema,
			validEdge({ metadata: { weight: 0.7, note: 'derived' } })
		);
		expect(result.success).toBe(true);
	});

	it('rejects edge missing each required field', () => {
		const required = ['id', 'from', 'to', 'kind', 'sessionId', 'createdAt'] as const;
		for (const field of required) {
			const edge = validEdge();
			delete edge[field];
			const result = v.safeParse(EdgeSchema, edge);
			expect(result.success, `missing ${field} should fail`).toBe(false);
		}
	});

	it('rejects empty from/to', () => {
		expect(v.safeParse(EdgeSchema, validEdge({ from: '' })).success).toBe(false);
		expect(v.safeParse(EdgeSchema, validEdge({ to: '' })).success).toBe(false);
	});
});

describe('generateUlid', () => {
	it('produces unique values across 1000 generations', () => {
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			ids.add(generateUlid());
		}
		expect(ids.size).toBe(1000);
	});
});
