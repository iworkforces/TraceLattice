import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PackedCliError, appendCleanupDiagnostics } from './packed-cli-cleanup.mjs';

const COMMAND_TIMEOUT_MS = 30_000;
const FORCE_CLOSE_MS = 5_000;
const STAGE = { packSucceeded: true, installSucceeded: true };

const runtimeConsumer = `import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createNodeServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as PublicApi from '@iworkforces/tracelattice';

assert.equal(typeof PublicApi.HttpTransport, 'function');
assert.equal(typeof PublicApi.createHttpTransport, 'function');
assert.equal(typeof PublicApi.ToolAwareSequentialThinkingServer, 'function');
assert.equal(typeof PublicApi.createServer, 'function');
assert.equal(typeof PublicApi.initializeServer, 'function');

for (const name of [
  'BaseTransport',
  'Container',
  'ServerConfig',
  'SkillRegistry',
  'StreamableHttpTransport',
  'ToolRegistry',
  'createStreamableHttpTransport',
]) {
  assert.equal(Object.hasOwn(PublicApi, name), false, \`internal export exposed: \${name}\`);
}

let deepImportBlocked = false;
try {
  await import('@iworkforces/tracelattice/dist/lib.js');
} catch (error) {
  assert.equal(error?.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
  deepImportBlocked = true;
}
assert.equal(deepImportBlocked, true);

const discoveryRoot = await mkdtemp(join(tmpdir(), 'tracelattice-packed-discovery-'));
const skillDir = join(discoveryRoot, 'skills');
const toolDir = join(discoveryRoot, 'tools');
const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  setLevel() {},
  getLevel() { return 'info'; },
};
let discoveryServer;
try {
  await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
  await Promise.all([
    writeFile(
      join(skillDir, 'packed.md'),
      '---\\nname: packed-skill\\ndescription: installed runtime\\n---\\n# Body',
      'utf8'
    ),
    writeFile(
      join(toolDir, 'packed.tool.md'),
      '---\\nname: packed-tool\\ndescription: installed runtime\\ninputSchema:\\n  type: object\\n---\\n# Body',
      'utf8'
    ),
  ]);
  discoveryServer = await PublicApi.createServer({
    logger: silentLogger,
    fileConfig: {
      skillDirs: [skillDir],
      toolDirs: [toolDir],
      features: { toolInterleave: false },
    },
    enableWatcher: false,
    autoDiscover: false,
    lazyDiscovery: true,
    loadFromPersistence: false,
  });
  assert.equal(typeof discoveryServer.refreshDiscovery, 'function');
  const firstRefresh = discoveryServer.refreshDiscovery();
  const concurrentRefresh = discoveryServer.refreshDiscovery();
  assert.equal(concurrentRefresh, firstRefresh);
  assert.deepEqual(await firstRefresh, { tools: 1, skills: 1 });
  const thoughtSessionId = 'packed-library-verification';
  const processed = await discoveryServer.processThought({
    thought: 'Verify the installed package-root library',
    thought_number: 1,
    total_thoughts: 1,
    next_thought_needed: false,
    session_id: thoughtSessionId,
  });
  assert.notEqual(processed.isError, true);
  assert.equal(Array.isArray(processed.content), true);
  const response = JSON.parse(processed.content[0].text);
  assert.equal(response.session_id, thoughtSessionId);
  assert.deepEqual(discoveryServer.getBranches(thoughtSessionId), {});
} finally {
  if (discoveryServer) await discoveryServer.dispose();
  await rm(discoveryRoot, { recursive: true, force: true });
}

const reservation = createNodeServer();
await new Promise((resolve, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', resolve);
});
const address = reservation.address();
assert.notEqual(address, null);
assert.equal(typeof address, 'object');
const port = address.port;
await new Promise((resolve, reject) => {
  reservation.close((error) => (error ? reject(error) : resolve()));
});

const transport = PublicApi.createHttpTransport({
  port,
  host: '127.0.0.1',
  path: '/verify-package-root',
  enableRateLimit: false,
});
assert.equal(transport instanceof PublicApi.HttpTransport, true);

let primaryFailure;
try {
  await transport.connect({
    async receive(message) {
      return { jsonrpc: '2.0', id: message.id, result: { packageRoot: true } };
    },
  });
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'packed-library-http',
    method: 'tools/list',
    params: {},
  });
  const response = await new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/verify-package-root',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (incoming) => {
        let responseBody = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => (responseBody += chunk));
        incoming.once('end', () =>
          resolve({ statusCode: incoming.statusCode, body: responseBody })
        );
      }
    );
    outgoing.once('error', reject);
    outgoing.end(body);
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    jsonrpc: '2.0',
    id: 'packed-library-http',
    result: { packageRoot: true },
  });
} catch (error) {
  primaryFailure = error;
}

try {
  await transport.stop();
} catch (error) {
  if (primaryFailure) {
    throw new AggregateError([primaryFailure, error], 'HTTP exchange and shutdown failed', {
      cause: primaryFailure,
    });
  }
  throw error;
}
if (primaryFailure) throw primaryFailure;
`;

const declarationConsumer = `import {
  HttpTransport,
  ToolAwareSequentialThinkingServer,
  createHttpTransport,
  createServer,
  initializeServer,
  type HttpTransportOptions,
  type IToolAwareSequentialThinkingServer,
  type ITransport,
  type TransportKind,
  type TransportOptions,
} from '@iworkforces/tracelattice';

const commonOptions: TransportOptions = {
  port: 9108,
  host: '127.0.0.1',
  enableRateLimit: false,
};
const options: HttpTransportOptions = { ...commonOptions, path: '/messages' };
const classTransport: ITransport = new HttpTransport(options);
const factoryTransport: ITransport = createHttpTransport(options);
const kind: TransportKind = factoryTransport.kind;
const serverClass: typeof ToolAwareSequentialThinkingServer = ToolAwareSequentialThinkingServer;
const serverFactory: typeof createServer = createServer;
const serverInitializer: typeof initializeServer = initializeServer;
type Exact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type ExpectedDiscoveryRefresh = Promise<{ tools: number; skills: number }>;
type InterfaceDiscoveryRefresh = ReturnType<
  IToolAwareSequentialThinkingServer['refreshDiscovery']
>;
type ClassDiscoveryRefresh = ReturnType<
  ToolAwareSequentialThinkingServer['refreshDiscovery']
>;
type InterfaceProcessInput = Parameters<
  IToolAwareSequentialThinkingServer['processThought']
>[0];
type ClassProcessInput = Parameters<ToolAwareSequentialThinkingServer['processThought']>[0];
type InterfaceGetBranchesParameters = Parameters<
  IToolAwareSequentialThinkingServer['getBranches']
>;
type ClassGetBranchesParameters = Parameters<ToolAwareSequentialThinkingServer['getBranches']>;
const exactInterfaceDiscoveryRefresh: Exact<
  InterfaceDiscoveryRefresh,
  ExpectedDiscoveryRefresh
> = true;
const exactClassDiscoveryRefresh: Exact<
  ClassDiscoveryRefresh,
  ExpectedDiscoveryRefresh
> = true;
const interfaceSessionRequired: {} extends Pick<InterfaceProcessInput, 'session_id'>
  ? false
  : true = true;
const classSessionRequired: {} extends Pick<ClassProcessInput, 'session_id'> ? false : true = true;
const exactInterfaceGetBranches: Exact<InterfaceGetBranchesParameters, [sessionId: string]> = true;
const exactClassGetBranches: Exact<ClassGetBranchesParameters, [sessionId: string]> = true;

void classTransport;
void kind;
void serverClass;
void serverFactory;
void serverInitializer;
void exactInterfaceDiscoveryRefresh;
void exactClassDiscoveryRefresh;
void interfaceSessionRequired;
void classSessionRequired;
void exactInterfaceGetBranches;
void exactClassGetBranches;
`;

async function runCommand(command, args, options) {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: process.env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
	child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
	const closed = new Promise((resolveClose, reject) => {
		child.once('error', reject);
		child.once('close', (code, signal) => resolveClose({ code, signal }));
	});
	let forceTimer;
	const deadline = setTimeout(() => {
		child.kill('SIGTERM');
		forceTimer = setTimeout(() => child.kill('SIGKILL'), FORCE_CLOSE_MS);
	}, COMMAND_TIMEOUT_MS);
	const status = await closed.finally(() => {
		clearTimeout(deadline);
		if (forceTimer) clearTimeout(forceTimer);
	});
	if (status.code !== 0 || status.signal !== null) {
		const diagnostics = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
		throw new PackedCliError(
			options.code,
			`${options.label} failed (${status.code ?? status.signal}): ${diagnostics}`,
			STAGE
		);
	}
	if (options.silent && (stdout !== '' || stderr !== '')) {
		throw new PackedCliError(
			options.code,
			`${options.label} produced output: ${[stdout.trim(), stderr.trim()].filter(Boolean).join('\n')}`,
			STAGE
		);
	}
}

function asVerificationError(error, code, label) {
	if (error instanceof PackedCliError) return error;
	return new PackedCliError(code, `${label}: ${String(error)}`, STAGE);
}

export async function verifyPackedLibraryApi(artifact, repositoryRoot) {
	const verificationRoot = join(artifact.consumerRoot, '.tracelattice-library-verification');
	const runtimePath = join(verificationRoot, 'runtime-consumer.mjs');
	const declarationPath = join(verificationRoot, 'declaration-consumer.ts');
	const projectPath = join(verificationRoot, 'tsconfig.json');
	let primary;
	try {
		await mkdir(verificationRoot);
		await writeFile(runtimePath, runtimeConsumer);
		await writeFile(declarationPath, declarationConsumer);
		await writeFile(
			projectPath,
			`${JSON.stringify(
				{
					compilerOptions: {
						target: 'ES2023',
						module: 'NodeNext',
						moduleResolution: 'NodeNext',
						strict: true,
						noEmit: true,
						noUncheckedIndexedAccess: true,
						exactOptionalPropertyTypes: true,
						verbatimModuleSyntax: true,
						skipLibCheck: true,
						types: ['node'],
						typeRoots: [resolve(repositoryRoot, 'node_modules/@types')],
					},
					files: [declarationPath],
				},
				null,
				2
			)}\n`
		);

		await runCommand(process.execPath, [runtimePath], {
			cwd: artifact.consumerRoot,
			code: 'PACKED_LIBRARY_RUNTIME_FAILED',
			label: 'installed package-root runtime consumer',
			silent: true,
		});
		await runCommand(
			process.execPath,
			[
				resolve(repositoryRoot, 'node_modules/typescript/bin/tsc'),
				'--project',
				projectPath,
				'--noEmit',
			],
			{
				cwd: artifact.consumerRoot,
				code: 'PACKED_LIBRARY_TYPES_FAILED',
				label: 'installed package-root declaration consumer',
				silent: true,
			}
		);
	} catch (error) {
		primary = asVerificationError(
			error,
			'PACKED_LIBRARY_RUNTIME_FAILED',
			'installed package-root verification failed'
		);
	}

	const cleanupErrors = await Promise.allSettled([
		rm(verificationRoot, { recursive: true, force: true }),
	]).then((results) =>
		results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
	);
	if (primary) throw appendCleanupDiagnostics(primary, cleanupErrors);
	if (cleanupErrors.length > 0) {
		throw appendCleanupDiagnostics(
			new PackedCliError('PACKED_CLEANUP_FAILED', 'library consumer cleanup failed', STAGE),
			cleanupErrors
		);
	}
}
