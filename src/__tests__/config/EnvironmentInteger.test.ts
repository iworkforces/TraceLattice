import { describe, expect, it } from 'vitest';
import { parseEnvironmentInteger } from '../../config/EnvironmentInteger.js';
import { ConfigurationError } from '../../errors.js';

describe('parseEnvironmentInteger', () => {
	it.each(['0', '1', '9007', '9007199254740991'])('accepts unsigned decimal %s', (raw) => {
		expect(parseEnvironmentInteger('TEST_INTEGER', raw)).toBe(Number(raw));
	});
	it.each(['', '00', '01', '-1', '+1', ' 1', '1 ', '1\n', '1.5', '9007abc', '1e3'])(
		'rejects malformed %j with the existing message',
		(raw) => {
			expect(() => parseEnvironmentInteger('TEST_INTEGER', raw)).toThrow(ConfigurationError);
			expect(() => parseEnvironmentInteger('TEST_INTEGER', raw)).toThrow(
				`TEST_INTEGER must be an integer, got ${raw}`
			);
		}
	);
	it('rejects unsafe integers with the existing message', () => {
		expect(() => parseEnvironmentInteger('TEST_INTEGER', '9007199254740992')).toThrow(
			'TEST_INTEGER must be a safe integer, got 9007199254740992'
		);
	});
});
