import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

type FixtureManifest = Record<string, unknown>;
type FixtureCase = {
	readonly label: string;
	readonly code: string;
	readonly packSucceeded?: boolean;
	readonly mutate: (root: string, manifest: FixtureManifest) => Promise<void>;
};
type ProcessResult = {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
};
type VerifierOptions = {
	readonly loader?: string;
	readonly env?: NodeJS.ProcessEnv;
};

const verifier = fileURLToPath(new URL('../../../scripts/verify-packed-cli.mjs', import.meta.url));
const cleanupModuleUrl = new URL('../../../scripts/packed-cli-cleanup.mjs', import.meta.url).href;
const temporaryRoots: string[] = [];
const cliBody = `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) {
  console.log('tracelattice v1.2.3');
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.method === 'notifications/initialized') return;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'tracelattice', version: '1.2.3' } };
    else if (request.method === 'tools/list') result = { tools: [{ name: 'sequentialthinking_tools' }] };
    else {
      const input = request.params?.arguments;
      const validSession = typeof input?.session_id === 'string' && input.session_id !== '__global__';
      result = validSession
        ? { content: [{ type: 'text', text: JSON.stringify({ session_id: input.session_id }) }] }
        : { isError: true, content: [{ type: 'text', text: 'invalid session' }] };
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
}
`;
const libraryBody = `import { createServer as createNodeServer } from 'node:http';
export class HttpTransport {
  constructor(options = {}) {
    this.port = options.port ?? 9108;
    this.host = options.host ?? '127.0.0.1';
    this.path = options.path ?? '/messages';
    this.receiver = null;
    this.server = createNodeServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== this.path) {
        response.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      const result = await this.receiver.receive(message, { sessionInfo: {} });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    });
  }
  get kind() { return 'http'; }
  get clientCount() { return 0; }
  get isShuttingDown() { return false; }
  get serverUrl() { return \`http://\${this.host}:\${this.port}\`; }
  async connect(receiver) {
    this.receiver = receiver;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
  }
  async stop() {
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}
export function createHttpTransport(options = {}) { return new HttpTransport(options); }
export class ToolAwareSequentialThinkingServer {
  constructor() { this.refresh = undefined; }
  refreshDiscovery() {
    this.refresh ??= Promise.resolve({ tools: 1, skills: 1 });
    return this.refresh;
  }
  getBranches(sessionId) {
    if (typeof sessionId !== 'string') throw new TypeError('sessionId is required');
    return {};
  }
  async processThought(input) {
    if (typeof input.session_id !== 'string' || input.session_id === '__global__') {
      return { isError: true, content: [{ type: 'text', text: 'invalid session' }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ session_id: input.session_id }) }] };
  }
  async stop() {}
  async dispose() {}
}
export async function createServer() { return new ToolAwareSequentialThinkingServer(); }
export async function initializeServer() { return createServer(); }
`;
const libraryDeclarations = `export type TransportKind = 'http' | 'streamable-http';
export interface TransportOptions {
  readonly port?: number;
  readonly host?: string;
  readonly enableRateLimit?: boolean;
}
export interface HttpTransportOptions extends TransportOptions { readonly path?: string; }
export interface ITransport {
  readonly kind: TransportKind;
  readonly clientCount: number;
  readonly isShuttingDown: boolean;
  readonly serverUrl: string;
  connect(server: object): Promise<void>;
  stop(timeout?: number): Promise<void>;
}
export declare class HttpTransport implements ITransport {
  constructor(options?: HttpTransportOptions);
  readonly kind: 'http';
  readonly clientCount: number;
  readonly isShuttingDown: boolean;
  readonly serverUrl: string;
  connect(server: object): Promise<void>;
  stop(timeout?: number): Promise<void>;
}
export declare function createHttpTransport(options?: HttpTransportOptions): HttpTransport;
export interface ServerOptions { readonly autoDiscover?: boolean; readonly loadFromPersistence?: boolean; }
export interface IToolAwareSequentialThinkingServer {
  refreshDiscovery(): Promise<{ tools: number; skills: number }>;
  getBranches(sessionId: string): Record<string, readonly object[]>;
  processThought(input: { readonly session_id: string; readonly thought: string; readonly thought_number: number; readonly total_thoughts: number }): Promise<{ readonly content: readonly { readonly type: 'text'; readonly text: string }[]; readonly isError?: boolean }>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
export declare class ToolAwareSequentialThinkingServer implements IToolAwareSequentialThinkingServer {
  static create(options?: ServerOptions): Promise<ToolAwareSequentialThinkingServer>;
  refreshDiscovery(): Promise<{ tools: number; skills: number }>;
  getBranches(sessionId: string): Record<string, readonly object[]>;
  processThought(input: { readonly session_id: string; readonly thought: string; readonly thought_number: number; readonly total_thoughts: number }): Promise<{ readonly content: readonly { readonly type: 'text'; readonly text: string }[]; readonly isError?: boolean }>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
export declare function createServer(options?: ServerOptions): Promise<ToolAwareSequentialThinkingServer>;
export declare function initializeServer(): Promise<ToolAwareSequentialThinkingServer>;
`;

const cases: readonly FixtureCase[] = [
	{
		label: 'missing CLI',
		code: 'PACKED_CLI_MISSING',
		mutate: async (root) => rm(join(root, 'dist/cli.js')),
	},
	{
		label: 'missing root import',
		code: 'PACKED_EXPORT_MISSING: . import',
		mutate: async (_root, manifest) => {
			manifest.exports = { '.': { types: './dist/lib.d.ts' }, './package.json': './package.json' };
		},
	},
	{
		label: 'physically missing root import target',
		code: 'PACKED_EXPORT_MISSING: . import',
		mutate: async (root) => rm(join(root, 'dist/lib.js')),
	},
	{
		label: 'missing root types',
		code: 'PACKED_EXPORT_MISSING: . types',
		mutate: async (_root, manifest) => {
			manifest.exports = { '.': { import: './dist/lib.js' }, './package.json': './package.json' };
		},
	},
	{
		label: 'physically missing root types target',
		code: 'PACKED_EXPORT_MISSING: . types',
		mutate: async (root) => rm(join(root, 'dist/lib.d.ts')),
	},
	{
		label: 'missing package export',
		code: 'PACKED_EXPORT_MISSING: ./package.json',
		mutate: async (_root, manifest) => {
			manifest.exports = {
				'.': { types: './dist/lib.d.ts', import: './dist/lib.js' },
			};
		},
	},
	{
		label: 'missing bin key',
		code: 'PACKED_BIN_MISSING: tracelattice',
		mutate: async (_root, manifest) => {
			manifest.bin = { other: './dist/cli.js' };
		},
	},
	{
		label: 'absolute bin',
		code: 'PACKED_BIN_INVALID',
		mutate: async (_root, manifest) => {
			manifest.bin = { tracelattice: '/dist/cli.js' };
		},
	},
	{
		label: 'traversal bin',
		code: 'PACKED_BIN_INVALID',
		mutate: async (_root, manifest) => {
			manifest.bin = { tracelattice: '../cli.js' };
		},
	},
	{
		label: 'non-string bin',
		code: 'PACKED_BIN_INVALID',
		mutate: async (_root, manifest) => {
			manifest.bin = { tracelattice: 42 };
		},
	},
	{
		label: 'wrong shebang',
		code: 'PACKED_CLI_SHEBANG',
		mutate: async (root) => writeFile(join(root, 'dist/cli.js'), cliBody.replace('bun', 'node')),
	},
	{
		label: 'missing shebang',
		code: 'PACKED_CLI_SHEBANG',
		mutate: async (root) =>
			writeFile(join(root, 'dist/cli.js'), cliBody.slice(cliBody.indexOf('\n') + 1)),
	},
	{
		label: 'wrong package name',
		code: 'PACKED_NAME_INVALID',
		mutate: async (_root, manifest) => {
			manifest.name = 'not-tracelattice';
		},
	},
	{
		label: 'missing publish files contract',
		code: 'PACKED_FILES_INVALID',
		mutate: async (_root, manifest) => {
			delete manifest.files;
		},
	},
	{
		label: 'traversing publish file entry',
		code: 'PACKED_FILES_INVALID',
		mutate: async (_root, manifest) => {
			manifest.files = ['dist', 'README.md', 'LICENSE', '../outside'];
		},
	},
	{
		label: 'broken runtime root export with library file present',
		code: 'PACKED_LIBRARY_RUNTIME_FAILED',
		mutate: async (root) =>
			writeFile(
				join(root, 'dist/lib.js'),
				libraryBody.replace('export function createHttpTransport', 'function createHttpTransport')
			),
	},
	{
		label: 'broken root declaration with declaration file present',
		code: 'PACKED_LIBRARY_TYPES_FAILED',
		mutate: async (root) =>
			writeFile(
				join(root, 'dist/lib.d.ts'),
				libraryDeclarations.replace(
					'export declare function createHttpTransport(options?: HttpTransportOptions): HttpTransport;\n',
					''
				)
			),
	},
	{
		label: 'removed registry alias in build output',
		code: 'BUILD_CURRENT_CONTRACT_INVALID',
		packSucceeded: false,
		mutate: async (root) =>
			writeFile(
				join(root, 'dist/lib.d.ts'),
				`${libraryDeclarations}\nexport declare function addTool(value: unknown): void;\n`
			),
	},
	{
		label: 'retired global session symbol in build output',
		code: 'BUILD_CURRENT_CONTRACT_INVALID',
		packSucceeded: false,
		mutate: async (root) =>
			writeFile(
				join(root, 'dist/lib.js'),
				`${libraryBody}\nexport const GLOBAL_SESSION_ID = '__global__';\n`
			),
	},
	{
		label: 'retired global session accepted by a constructor in build output',
		code: 'BUILD_CURRENT_CONTRACT_INVALID',
		packSucceeded: false,
		mutate: async (root) =>
			writeFile(
				join(root, 'dist/lib.js'),
				`${libraryBody}\nfunction asSessionId(value) { return value; }\nexport const defaultSession = asSessionId('__global__');\n`
			),
	},
	{
		label: 'optional public thought session declaration in build output',
		code: 'BUILD_CURRENT_CONTRACT_INVALID',
		packSucceeded: false,
		mutate: async (root) =>
			writeFile(
				join(root, 'dist/lib.d.ts'),
				libraryDeclarations.replace(
					'getBranches(sessionId: string)',
					'getBranches(sessionId?: string)'
				)
			),
	},
	{
		label: 'thought session fallback in build output',
		code: 'BUILD_CURRENT_CONTRACT_INVALID',
		packSucceeded: false,
		mutate: async (root) =>
			writeFile(
				join(root, 'dist/lib.js'),
				`${libraryBody}\nexport function fallback(input) { return input.session_id ?? 'default-session'; }\n`
			),
	},
	{
		label: 'packed CLI accepting an omitted thought session',
		code: 'PACKED_PROTOCOL_INVALID',
		mutate: async (root) =>
			writeFile(
				join(root, 'dist/cli.js'),
				cliBody
					.replace(
						"typeof input?.session_id === 'string' && input.session_id !== '__global__'",
						"input === undefined || input.session_id !== '__global__'"
					)
					.replace('JSON.stringify({ session_id: input.session_id })', 'JSON.stringify({})')
			),
	},
	{
		label: 'packed CLI accepting the retired thought session',
		code: 'PACKED_PROTOCOL_INVALID',
		mutate: async (root) =>
			writeFile(
				join(root, 'dist/cli.js'),
				cliBody.replace(
					"typeof input?.session_id === 'string' && input.session_id !== '__global__'",
					"typeof input?.session_id === 'string'"
				)
			),
	},
];

async function createFixture(fixtureCase: FixtureCase): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'tracelattice-packed-fixture-'));
	temporaryRoots.push(root);
	await mkdir(join(root, 'dist'));
	await writeFile(join(root, 'README.md'), 'fixture\n');
	await writeFile(join(root, 'LICENSE'), 'fixture\n');
	await writeFile(join(root, 'dist/lib.js'), libraryBody);
	await writeFile(join(root, 'dist/lib.d.ts'), libraryDeclarations);
	await writeFile(join(root, 'dist/cli.js'), cliBody);
	await chmod(join(root, 'dist/cli.js'), 0o755);
	const manifest: FixtureManifest = {
		name: '@iworkforces/tracelattice',
		version: '1.2.3',
		type: 'module',
		main: 'dist/lib.js',
		types: 'dist/lib.d.ts',
		exports: {
			'.': { types: './dist/lib.d.ts', import: './dist/lib.js' },
			'./package.json': './package.json',
		},
		bin: { tracelattice: './dist/cli.js' },
		files: ['dist', 'README.md', 'LICENSE'],
	};
	await fixtureCase.mutate(root, manifest);
	await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	return root;
}

async function runVerifier(
	packageDirectory: string,
	{ loader, env }: VerifierOptions = {}
): Promise<ProcessResult> {
	const nodeArguments = loader
		? ['--experimental-loader', loader, verifier, '--package-dir', packageDirectory]
		: [verifier, '--package-dir', packageDirectory];
	const child = spawn(process.execPath, nodeArguments, {
		stdio: ['ignore', 'pipe', 'pipe'],
		env,
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
		stderr += chunk;
	});
	const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code) => {
			clearTimeout(timeout);
			resolve({ code, stdout, stderr });
		});
	});
}

async function createCleanupFailureLoader(): Promise<string> {
	const loaderRoot = await mkdtemp(join(tmpdir(), 'tracelattice-cleanup-loader-'));
	temporaryRoots.push(loaderRoot);
	const loader = join(loaderRoot, 'cleanup-failure-loader.mjs');
	await writeFile(
		loader,
		`const cleanupModuleUrl = ${JSON.stringify(cleanupModuleUrl)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:fs/promises' && context.parentURL === cleanupModuleUrl) {
    return { url: 'cleanup-failure:fs-promises', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url !== 'cleanup-failure:fs-promises') return nextLoad(url, context);
  return {
    format: 'module',
    shortCircuit: true,
    source: \`import * as fs from 'node:fs/promises';
import { basename } from 'node:path';
export const { access, mkdtemp, readFile, readdir, writeFile } = fs;
let rejected = false;
export async function rm(path, options) {
  if (!rejected && typeof path === 'string' && basename(path).startsWith('tracelattice-consumer-')) {
    rejected = true;
    await fs.rm(path, options);
    throw new Error('injected consumer cleanup rejection');
  }
  return fs.rm(path, options);
}\`,
  };
}
`
	);
	return loader;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('packed CLI artifact contract', () => {
	it('verifies named thought sessions through the installed library and CLI', async () => {
		// Given
		const packageDirectory = await createFixture({
			label: 'current explicit session contract',
			code: '',
			mutate: async () => undefined,
		});
		const runtimeRoot = await mkdtemp(join(tmpdir(), 'tracelattice-bun-runtime-'));
		temporaryRoots.push(runtimeRoot);
		await symlink(process.execPath, join(runtimeRoot, 'bun'));
		// When
		const result = await runVerifier(packageDirectory, {
			env: { ...process.env, PATH: `${runtimeRoot}${delimiter}${process.env.PATH ?? ''}` },
		});
		// Then
		expect(result.code).toBe(0);
		const receipt: unknown = JSON.parse(result.stdout);
		expect(receipt).toMatchObject({
			protocolCheck: {
				initialize: true,
				toolsList: true,
				validNamedSession: true,
				omittedSessionRejected: true,
				retiredSessionRejected: true,
			},
		});
	}, 120_000);

	it.each(cases)(
		'rejects $label with $code after packing and installing',
		async (fixtureCase) => {
			// Given
			const packageDirectory = await createFixture(fixtureCase);
			// When
			const result = await runVerifier(packageDirectory);
			// Then
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain(fixtureCase.code);
			const packed = fixtureCase.packSucceeded !== false;
			expect(result.stderr).toContain(`PACK_SUCCEEDED=${packed}`);
			expect(result.stderr).toContain(`INSTALL_SUCCEEDED=${packed}`);
		},
		120_000
	);

	it('rejects a packed CLI with the wrong MCP server name', async () => {
		// Given
		const packageDirectory = await createFixture({
			label: 'wrong MCP server name',
			code: 'PACKED_PROTOCOL_INVALID',
			mutate: async (root) =>
				writeFile(
					join(root, 'dist/cli.js'),
					cliBody.replace("serverInfo: { name: 'tracelattice'", "serverInfo: { name: 'wrong-name'")
				),
		});
		const runtimeRoot = await mkdtemp(join(tmpdir(), 'tracelattice-bun-runtime-'));
		temporaryRoots.push(runtimeRoot);
		await symlink(process.execPath, join(runtimeRoot, 'bun'));
		// When
		const result = await runVerifier(packageDirectory, {
			env: { ...process.env, PATH: `${runtimeRoot}${delimiter}${process.env.PATH ?? ''}` },
		});
		// Then
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('PACKED_PROTOCOL_INVALID');
		expect(result.stderr).toContain('serverInfo.name must be tracelattice');
	}, 120_000);

	it('preserves the semantic failure when package inspection cleanup also fails', async () => {
		// Given
		const missingImport = cases.find((fixtureCase) => fixtureCase.label === 'missing root import');
		if (!missingImport) throw new Error('missing root import fixture case is required');
		const packageDirectory = await createFixture(missingImport);
		const loader = await createCleanupFailureLoader();
		const before = new Set(
			(await readdir(tmpdir())).filter((entry) => /^tracelattice-(?:pack|consumer)-/.test(entry))
		);
		// When
		const result = await runVerifier(packageDirectory, { loader });
		// Then
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('PACKED_EXPORT_MISSING: . import');
		expect(result.stderr).toContain('injected consumer cleanup rejection');
		expect(result.stderr).toContain('PACK_SUCCEEDED=true');
		expect(result.stderr).toContain('INSTALL_SUCCEEDED=true');
		const leaked = (await readdir(tmpdir())).filter(
			(entry) => /^tracelattice-(?:pack|consumer)-/.test(entry) && !before.has(entry)
		);
		expect(leaked).toEqual([]);
	}, 120_000);

	it('preserves a library runtime failure when artifact cleanup also fails', async () => {
		// Given
		const brokenRuntime = cases.find(
			(fixtureCase) => fixtureCase.label === 'broken runtime root export with library file present'
		);
		if (!brokenRuntime) throw new Error('broken runtime fixture case is required');
		const packageDirectory = await createFixture(brokenRuntime);
		const loader = await createCleanupFailureLoader();
		const before = new Set(
			(await readdir(tmpdir())).filter((entry) => /^tracelattice-(?:pack|consumer)-/.test(entry))
		);
		// When
		const result = await runVerifier(packageDirectory, { loader });
		// Then
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('PACKED_LIBRARY_RUNTIME_FAILED');
		expect(result.stderr).toContain('injected consumer cleanup rejection');
		expect(result.stderr).toContain('PACK_SUCCEEDED=true');
		expect(result.stderr).toContain('INSTALL_SUCCEEDED=true');
		const leaked = (await readdir(tmpdir())).filter(
			(entry) => /^tracelattice-(?:pack|consumer)-/.test(entry) && !before.has(entry)
		);
		expect(leaked).toEqual([]);
	}, 120_000);
});
