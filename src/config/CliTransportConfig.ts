import { ConfigurationError } from '../errors.js';
import { parseEnvironmentInteger } from './EnvironmentInteger.js';

export const DEFAULT_STREAMABLE_HTTP_PORT = 9007;

export type CliSessionRetention = {
	readonly maxSessions: number;
	readonly sessionIdleTimeoutMs: number;
	readonly sessionSweepIntervalMs: number;
};

export type CliHttpTransportConfig = {
	readonly kind: 'streamable-http';
	readonly port: number;
	readonly host: string;
	readonly corsOrigin: string;
	readonly enableCors: boolean;
	readonly allowedHosts: string[] | undefined;
	readonly stateful: boolean;
	readonly retention: CliSessionRetention | undefined;
};

export type CliTransportConfig = { readonly kind: 'stdio' } | CliHttpTransportConfig;

const retentionNames = [
	'TRACELATTICE_STREAMABLE_HTTP_MAX_SESSIONS',
	'TRACELATTICE_STREAMABLE_HTTP_SESSION_IDLE_TIMEOUT_MS',
	'TRACELATTICE_STREAMABLE_HTTP_SESSION_SWEEP_INTERVAL_MS',
] as const;

function positiveRetentionInteger(env: NodeJS.ProcessEnv, name: string): number {
	const raw = env[name];
	if (raw === undefined) throw new ConfigurationError(`Missing ${name}`);
	const value = parseEnvironmentInteger(name, raw);
	if (value === 0) throw new ConfigurationError(`${name} must be greater than zero`);
	return value;
}

function parseRetention(
	env: NodeJS.ProcessEnv,
	stateful: boolean
): CliSessionRetention | undefined {
	const missing = retentionNames.filter((name) => env[name] === undefined);
	if (missing.length === retentionNames.length) return undefined;
	if (missing.length > 0) {
		throw new ConfigurationError(
			`Missing Streamable HTTP retention variables: ${missing.join(', ')}`
		);
	}
	if (!stateful) {
		throw new ConfigurationError(
			'Streamable HTTP retention requires TRACELATTICE_STREAMABLE_HTTP_STATEFUL to not be false'
		);
	}
	return {
		maxSessions: positiveRetentionInteger(env, retentionNames[0]),
		sessionIdleTimeoutMs: positiveRetentionInteger(env, retentionNames[1]),
		sessionSweepIntervalMs: positiveRetentionInteger(env, retentionNames[2]),
	};
}

export function parseCliTransportConfig(env: NodeJS.ProcessEnv): CliTransportConfig {
	const kind = env.TRACELATTICE_TRANSPORT_TYPE ?? 'stdio';
	if (kind === 'stdio') return { kind };
	if (kind !== 'streamable-http') {
		throw new ConfigurationError(
			`TRACELATTICE_TRANSPORT_TYPE must be one of stdio, streamable-http, got ${kind}`
		);
	}
	const port = parseEnvironmentInteger(
		'TRACELATTICE_STREAMABLE_HTTP_PORT',
		env.TRACELATTICE_STREAMABLE_HTTP_PORT ?? String(DEFAULT_STREAMABLE_HTTP_PORT)
	);
	if (port > 65535)
		throw new ConfigurationError('TRACELATTICE_STREAMABLE_HTTP_PORT must be between 0 and 65535');
	const stateful = env.TRACELATTICE_STREAMABLE_HTTP_STATEFUL !== 'false';
	return {
		kind,
		port,
		host: env.TRACELATTICE_STREAMABLE_HTTP_HOST || 'localhost',
		corsOrigin: env.TRACELATTICE_CORS_ORIGIN || '*',
		enableCors: env.TRACELATTICE_ENABLE_CORS !== 'false',
		allowedHosts: env.TRACELATTICE_ALLOWED_HOSTS?.split(',').map((hostValue) => hostValue.trim()),
		stateful,
		retention: parseRetention(env, stateful),
	};
}
