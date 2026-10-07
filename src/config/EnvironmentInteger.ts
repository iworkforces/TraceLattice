import { ConfigurationError } from '../errors.js';

export function parseEnvironmentInteger(environmentName: string, raw: string): number {
	if (!/^(0|[1-9]\d*)$/.test(raw)) {
		throw new ConfigurationError(`${environmentName} must be an integer, got ${raw}`);
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) {
		throw new ConfigurationError(`${environmentName} must be a safe integer, got ${raw}`);
	}
	return parsed;
}
