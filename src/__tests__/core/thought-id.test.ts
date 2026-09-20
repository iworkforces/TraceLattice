/**
 * Tests for thought.id (ulid) DAG node identity.
 *
 * Verifies:
 * - ThoughtData accepts optional id field
 * - InputNormalizer generates ulid when id not provided
 * - InputNormalizer preserves provided id
 * - Generated ids are unique across many normalizations
 * - Schema validates id field (accepts valid string, rejects empty)
 * - Thought data without an id receives one without changing other fields
 */

import { describe, it, expect } from 'vitest';
import { safeParse } from 'valibot';
import { normalizeInput } from '../../core/InputNormalizer.js';
import { asSessionId, asThoughtId } from '../../contracts/ids.js';
import { SequentialThinkingSchema } from '../../schema.js';
import type { ThoughtData } from '../../core/thought.js';

function baseInput(overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		thought: 'Test thought',
		thought_number: 1,
		total_thoughts: 1,
		next_thought_needed: false,
		session_id: 'thought-id-test',
		...overrides,
	};
}

describe('ThoughtData.id', () => {
	describe('type', () => {
		it('should accept optional id field on ThoughtData', () => {
			const thought: ThoughtData = {
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('thought-id-test'),
				id: asThoughtId('01h2k3m400a1b2c3d4e5f6a7b8'),
			};
			expect(thought.id).toBe('01h2k3m400a1b2c3d4e5f6a7b8');
		});

		it('should allow ThoughtData without an id field', () => {
			const thought: ThoughtData = {
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('thought-id-test'),
			};
			expect(thought.id).toBeUndefined();
		});
	});

	describe('InputNormalizer id generation', () => {
		it('should auto-generate id when not provided', () => {
			const normalized = normalizeInput(baseInput()) as ThoughtData;
			expect(normalized.id).toBeDefined();
			expect(typeof normalized.id).toBe('string');
			expect(normalized.id!.length).toBeGreaterThan(0);
		});

		it('should preserve provided id', () => {
			const provided = '01h2k3m400a1b2c3d4e5f6a7b8';
			const normalized = normalizeInput(baseInput({ id: provided })) as ThoughtData;
			expect(normalized.id).toBe(provided);
		});

		it('should generate unique ids across 1000 normalizations', () => {
			const ids = new Set<string>();
			for (let i = 0; i < 1000; i++) {
				const normalized = normalizeInput(baseInput()) as ThoughtData;
				ids.add(normalized.id!);
			}
			expect(ids.size).toBe(1000);
		});

		it('should regenerate id when input.id is empty string', () => {
			const normalized = normalizeInput(baseInput({ id: '' })) as ThoughtData;
			expect(normalized.id).toBeDefined();
			expect(normalized.id).not.toBe('');
			expect(normalized.id!.length).toBeGreaterThan(0);
		});

		it('should regenerate id when input.id is non-string', () => {
			const normalized = normalizeInput(baseInput({ id: 123 })) as ThoughtData;
			expect(typeof normalized.id).toBe('string');
			expect(normalized.id!.length).toBeGreaterThan(0);
		});
	});

	describe('Schema validation for id', () => {
		it('should accept valid id string', () => {
			const result = safeParse(
				SequentialThinkingSchema,
				baseInput({ id: '01h2k3m400a1b2c3d4e5f6a7b8' })
			);
			expect(result.success).toBe(true);
		});

		it('should accept input without id (optional)', () => {
			const result = safeParse(SequentialThinkingSchema, baseInput());
			expect(result.success).toBe(true);
		});

		it('should reject empty id string (minLength 1)', () => {
			const result = safeParse(SequentialThinkingSchema, baseInput({ id: '' }));
			expect(result.success).toBe(false);
		});

		it('should reject id longer than 30 chars', () => {
			const tooLong = 'a'.repeat(31);
			const result = safeParse(SequentialThinkingSchema, baseInput({ id: tooLong }));
			expect(result.success).toBe(false);
		});
	});

	describe('Generated identity', () => {
		it('should normalize thought data without changing non-id fields', () => {
			const input = baseInput({
				thought: 'Original thought',
				thought_number: 5,
				total_thoughts: 10,
				next_thought_needed: true,
			});
			const normalized = normalizeInput(input) as ThoughtData;
			expect(normalized.thought).toBe('Original thought');
			expect(normalized.thought_number).toBe(5);
			expect(normalized.total_thoughts).toBe(10);
			expect(normalized.next_thought_needed).toBe(true);
			// id auto-generated, but no other fields broken
			expect(normalized.id).toBeDefined();
		});
	});
});
