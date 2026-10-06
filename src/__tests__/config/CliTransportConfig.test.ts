import { describe, expect, it } from 'vitest';
import { parseCliTransportConfig } from '../../config/CliTransportConfig.js';
import { ConfigurationError } from '../../errors.js';

const http = { TRACELATTICE_TRANSPORT_TYPE: 'streamable-http' };
const retentionNames = [
	'TRACELATTICE_STREAMABLE_HTTP_MAX_SESSIONS',
	'TRACELATTICE_STREAMABLE_HTTP_SESSION_IDLE_TIMEOUT_MS',
	'TRACELATTICE_STREAMABLE_HTTP_SESSION_SWEEP_INTERVAL_MS',
] as const;
const retention = Object.fromEntries(
	retentionNames.map((name, index) => [name, String(index + 1)])
);

describe('CLI transport defaults and isolation', () => {
	it('defaults to stdio', () => expect(parseCliTransportConfig({})).toEqual({ kind: 'stdio' }));
	it('preserves HTTP defaults with unbounded sessions', () => {
		expect(parseCliTransportConfig(http)).toEqual({
			kind: 'streamable-http',
			port: 9007,
			host: 'localhost',
			corsOrigin: '*',
			enableCors: true,
			allowedHosts: undefined,
			stateful: true,
			retention: undefined,
		});
	});
	it.each([undefined, 'stdio'])('ignores all HTTP variables in stdio (%s)', (type) => {
		const env = Object.fromEntries(
			[
				...retentionNames,
				'TRACELATTICE_STREAMABLE_HTTP_PORT',
				'TRACELATTICE_STREAMABLE_HTTP_HOST',
				'TRACELATTICE_CORS_ORIGIN',
				'TRACELATTICE_ENABLE_CORS',
				'TRACELATTICE_ALLOWED_HOSTS',
				'TRACELATTICE_STREAMABLE_HTTP_STATEFUL',
			].map((name) => [name, 'garbage'])
		);
		expect(parseCliTransportConfig({ ...env, TRACELATTICE_TRANSPORT_TYPE: type })).toEqual({
			kind: 'stdio',
		});
	});
	it.each(['streamable_http', '', 'http'])('rejects unknown transport %j', (type) => {
		expect(() => parseCliTransportConfig({ TRACELATTICE_TRANSPORT_TYPE: type })).toThrow(
			ConfigurationError
		);
	});
	it('preserves host, CORS, allowlist and literal false semantics', () => {
		expect(
			parseCliTransportConfig({
				...http,
				TRACELATTICE_STREAMABLE_HTTP_HOST: '127.0.0.1',
				TRACELATTICE_CORS_ORIGIN: 'https://example.com',
				TRACELATTICE_ENABLE_CORS: 'false',
				TRACELATTICE_ALLOWED_HOSTS: ' a, b ,',
				TRACELATTICE_STREAMABLE_HTTP_STATEFUL: 'false',
			})
		).toMatchObject({
			host: '127.0.0.1',
			corsOrigin: 'https://example.com',
			enableCors: false,
			allowedHosts: ['a', 'b', ''],
			stateful: false,
		});
	});
	it('keeps empty string fallbacks and nonliteral booleans', () => {
		expect(
			parseCliTransportConfig({
				...http,
				TRACELATTICE_STREAMABLE_HTTP_HOST: '',
				TRACELATTICE_CORS_ORIGIN: '',
				TRACELATTICE_ENABLE_CORS: 'FALSE',
				TRACELATTICE_STREAMABLE_HTTP_STATEFUL: '0',
				TRACELATTICE_ALLOWED_HOSTS: '',
			})
		).toMatchObject({
			host: 'localhost',
			corsOrigin: '*',
			enableCors: true,
			stateful: true,
			allowedHosts: [''],
		});
	});
});

describe('CLI HTTP integers', () => {
	it.each(['0', '65535'])('accepts port %s', (port) => {
		expect(
			parseCliTransportConfig({ ...http, TRACELATTICE_STREAMABLE_HTTP_PORT: port })
		).toMatchObject({ port: Number(port) });
	});
	it.each(['65536', '9007abc', '', '01', '-1', '+1', ' 1', '1.5', '9007199254740992'])(
		'rejects port %j',
		(port) => {
			expect(() =>
				parseCliTransportConfig({ ...http, TRACELATTICE_STREAMABLE_HTTP_PORT: port })
			).toThrow(ConfigurationError);
		}
	);
	it.each([1, 2, 3, 4, 5, 6])(
		'rejects partial retention subset %s naming missing variables',
		(mask) => {
			const env = {
				...http,
				...Object.fromEntries(
					retentionNames.filter((_name, index) => mask & (1 << index)).map((name) => [name, '1'])
				),
			};
			for (const name of retentionNames.filter((_name, index) => !(mask & (1 << index)))) {
				expect(() => parseCliTransportConfig(env)).toThrow(name);
			}
		}
	);
	it.each(retentionNames)('rejects zero and empty retention %s', (name) => {
		for (const raw of ['0', '', '1abc', '9007199254740992']) {
			expect(() => parseCliTransportConfig({ ...http, ...retention, [name]: raw })).toThrow(
				ConfigurationError
			);
		}
	});
	it('rejects retention with stateful=false', () => {
		expect(() =>
			parseCliTransportConfig({
				...http,
				...retention,
				TRACELATTICE_STREAMABLE_HTTP_STATEFUL: 'false',
			})
		).toThrow(ConfigurationError);
	});
	it('maps a full retention set', () => {
		expect(parseCliTransportConfig({ ...http, ...retention })).toMatchObject({
			retention: { maxSessions: 1, sessionIdleTimeoutMs: 2, sessionSweepIntervalMs: 3 },
		});
	});
});
