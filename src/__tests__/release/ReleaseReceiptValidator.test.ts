import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

type ProcessResult = {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
};

const validator = fileURLToPath(
	new URL('../../../scripts/validate-release-receipt.mjs', import.meta.url)
);
const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const tarballName = 'iworkforces-tracelattice-1.2.3.tgz';
const temporaryRoots: string[] = [];

function createReceipt(tarball: Buffer, receiptSourceSha: string | null = sourceSha) {
	return {
		schemaVersion: 1,
		sourceSha: receiptSourceSha,
		name: '@iworkforces/tracelattice',
		version: '1.2.3',
		tarball: {
			basename: tarballName,
			size: tarball.byteLength,
			sha256: createHash('sha256').update(tarball).digest('hex'),
		},
		packedFiles: ['README.md', 'package.json', 'dist/cli.js', 'dist/lib.js', 'dist/lib.d.ts'],
		manifest: {
			name: '@iworkforces/tracelattice',
			version: '1.2.3',
			main: 'dist/lib.js',
			types: 'dist/lib.d.ts',
			exports: {
				'.': { types: './dist/lib.d.ts', import: './dist/lib.js' },
				'./package.json': './package.json',
			},
			bin: { tracelattice: './dist/cli.js' },
			files: ['dist', 'README.md', 'LICENSE'],
		},
		checks: { shebang: '#!/usr/bin/env bun', executable: true },
		versionCheck: { exitCode: 0, output: 'tracelattice v1.2.3' },
		protocolCheck: {
			initialize: true,
			toolsList: true,
			validCall: true,
			invalidCall: true,
		},
		shutdownCheck: { exitCode: 0, signal: null, outstandingRequests: 0 },
		cleanup: { tempRootsRemoved: true, outputPreserved: true },
	};
}

type Receipt = ReturnType<typeof createReceipt>;

async function createArtifact(): Promise<{ readonly root: string; readonly receipt: Receipt }> {
	const root = await mkdtemp(join(tmpdir(), 'tracelattice-release-receipt-'));
	temporaryRoots.push(root);
	const tarball = Buffer.from('packed release bytes\n');
	const receipt = createReceipt(tarball);
	await writeFile(join(root, tarballName), tarball);
	await writeReceipt(root, receipt);
	return { root, receipt };
}

async function writeReceipt(root: string, receipt: Receipt): Promise<void> {
	await writeFile(join(root, 'verification.json'), `${JSON.stringify(receipt, null, 2)}\n`);
	await writeFile(
		join(root, 'SHA256SUMS'),
		`${receipt.tarball.sha256}  ${receipt.tarball.basename}\n`
	);
}

async function runValidator(env: NodeJS.ProcessEnv): Promise<ProcessResult> {
	return runNode([validator], env);
}

async function runImportedValidator(
	artifactDirectory: string,
	expectedSourceSha: string | null
): Promise<ProcessResult> {
	const source = `
import { validateReleaseReceipt } from ${JSON.stringify(pathToFileURL(validator).href)};
const result = await validateReleaseReceipt(${JSON.stringify({
		artifactDirectory,
		expectedSourceSha,
	})});
process.stdout.write(JSON.stringify(result));
`;
	return runNode(['--input-type=module', '--eval', source], process.env);
}

async function runNode(args: readonly string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> {
	const child = spawn(process.execPath, args, {
		env: { ...env, ARTIFACT_DIR: env.ARTIFACT_DIR, EXPECTED_SHA: env.EXPECTED_SHA },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
		stderr += chunk;
	});
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code) => resolve({ code, stdout, stderr }));
	});
}

async function snapshot(root: string): Promise<readonly string[]> {
	const entries = await readdir(root);
	return Promise.all(
		entries.sort().map(async (entry) => {
			const path = join(root, entry);
			const metadata = await lstat(path);
			const contents = metadata.isFile() ? await readFile(path, 'hex') : '';
			return `${entry}:${metadata.mode}:${metadata.size}:${metadata.mtimeMs}:${contents}`;
		})
	);
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('release receipt validator', () => {
	it('returns release outputs without modifying a valid artifact', async () => {
		// Given
		const { root } = await createArtifact();
		const before = await snapshot(root);
		// When
		const result = await runImportedValidator(root, sourceSha);
		// Then
		expect(result).toEqual({
			code: 0,
			stdout: JSON.stringify({
				version: '1.2.3',
				tag: 'v1.2.3',
				tarball: join(root, tarballName),
			}),
			stderr: '',
		});
		expect(await snapshot(root)).toEqual(before);
	});

	it('requires an exact null source SHA in imported null mode', async () => {
		// Given
		const { root, receipt } = await createArtifact();
		receipt.sourceSha = null;
		await writeReceipt(root, receipt);
		// When
		const accepted = await runImportedValidator(root, null);
		const rejected = await runImportedValidator(root, sourceSha);
		// Then
		expect(accepted.code).toBe(0);
		expect(rejected.code).not.toBe(0);
		expect(rejected.stdout).toBe('');
	});

	it('writes all successful CLI outputs atomically and nothing to stderr', async () => {
		// Given
		const { root } = await createArtifact();
		// When
		const result = await runValidator({ ...process.env, ARTIFACT_DIR: root, EXPECTED_SHA: sourceSha });
		// Then
		expect(result).toEqual({
			code: 0,
			stdout: `version=1.2.3\ntag=v1.2.3\ntarball=${join(root, tarballName)}\n`,
			stderr: '',
		});
	});

	it.each(['\0', '\r', '\n'])('rejects imported artifact paths containing %j', async (control) => {
		// Given
		const artifactDirectory = `${tmpdir()}/tracelattice-release${control}unsafe`;
		// When
		const result = await runImportedValidator(artifactDirectory, sourceSha);
		// Then
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe('');
	});

	it('rejects a real newline-bearing artifact path without partial CLI output', async () => {
		// Given
		const { root } = await createArtifact();
		const unsafeRoot = `${root}\ninjected=value`;
		await rename(root, unsafeRoot);
		temporaryRoots.push(unsafeRoot);
		// When
		const result = await runValidator({
			...process.env,
			ARTIFACT_DIR: unsafeRoot,
			EXPECTED_SHA: sourceSha,
		});
		// Then
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('RELEASE_RECEIPT_INVALID');
	});

	it.each([
		['missing ARTIFACT_DIR', { EXPECTED_SHA: sourceSha }],
		['relative ARTIFACT_DIR', { ARTIFACT_DIR: 'relative', EXPECTED_SHA: sourceSha }],
		['missing EXPECTED_SHA', { ARTIFACT_DIR: '/tmp' }],
		['uppercase EXPECTED_SHA', { ARTIFACT_DIR: '/tmp', EXPECTED_SHA: sourceSha.toUpperCase() }],
	])('rejects %s without partial stdout', async (_label, environment) => {
		// Given
		const env = { ...process.env, ARTIFACT_DIR: undefined, EXPECTED_SHA: undefined, ...environment };
		// When
		const result = await runValidator(env);
		// Then
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe('');
		expect(result.stderr).not.toBe('');
	});

	it.each([
		['malformed JSON', async (root: string) => writeFile(join(root, 'verification.json'), '{')],
		[
			'oversized receipt',
			async (root: string) => writeFile(join(root, 'verification.json'), ' '.repeat(1_048_577)),
		],
		['missing entry', async (root: string) => rm(join(root, 'SHA256SUMS'))],
		['extra entry', async (root: string) => writeFile(join(root, 'extra.txt'), 'extra')],
		['second tarball', async (root: string) => writeFile(join(root, 'other.tgz'), 'other')],
		[
			'child symlink',
			async (root: string) => {
				await rm(join(root, 'SHA256SUMS'));
				await symlink(join(root, 'verification.json'), join(root, 'SHA256SUMS'));
			},
		],
		[
			'child non-file',
			async (root: string) => {
				await rm(join(root, 'SHA256SUMS'));
				await mkdir(join(root, 'SHA256SUMS'));
			},
		],
	])('rejects artifact topology with %s', async (_label, mutate) => {
		// Given
		const { root } = await createArtifact();
		await mutate(root);
		// When
		const result = await runImportedValidator(root, sourceSha);
		// Then
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe('');
	});

	it('rejects an artifact root symlink', async () => {
		// Given
		const { root } = await createArtifact();
		const linkRoot = `${root}-link`;
		temporaryRoots.push(linkRoot);
		await symlink(root, linkRoot);
		// When
		const result = await runImportedValidator(linkRoot, sourceSha);
		// Then
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe('');
	});

	it.each([
		['invalid sections', (receipt: Receipt) => Object.assign(receipt, { checks: null })],
		['wrong schema version', (receipt: Receipt) => (receipt.schemaVersion = 2)],
		['wrong source SHA', (receipt: Receipt) => (receipt.sourceSha = '1'.repeat(40))],
		['wrong package name', (receipt: Receipt) => (receipt.name = 'other-package')],
		['invalid package version', (receipt: Receipt) => (receipt.version = '1.2')],
		['inconsistent manifest name', (receipt: Receipt) => (receipt.manifest.name = 'other')],
		['wrong manifest main', (receipt: Receipt) => (receipt.manifest.main = 'dist/other.js')],
		['wrong manifest types', (receipt: Receipt) => (receipt.manifest.types = 'dist/other.d.ts')],
		[
			'wrong root import',
			(receipt: Receipt) => (receipt.manifest.exports['.'].import = './dist/other.js'),
		],
		[
			'wrong package export',
			(receipt: Receipt) => (receipt.manifest.exports['./package.json'] = './other.json'),
		],
		['wrong manifest bin', (receipt: Receipt) => (receipt.manifest.bin.tracelattice = './other.js')],
		['unsafe manifest path', (receipt: Receipt) => receipt.manifest.files.push('../outside')],
		['missing dist publish path', (receipt: Receipt) => receipt.manifest.files.splice(0, 1)],
		['unsafe packed path', (receipt: Receipt) => receipt.packedFiles.push('/absolute')],
		['duplicate packed path', (receipt: Receipt) => receipt.packedFiles.push('dist/cli.js')],
		['missing packed member', (receipt: Receipt) => receipt.packedFiles.splice(1, 1)],
		['wrong tarball basename', (receipt: Receipt) => (receipt.tarball.basename = 'other.tgz')],
		['size mismatch', (receipt: Receipt) => (receipt.tarball.size += 1)],
		['hash metadata mismatch', (receipt: Receipt) => (receipt.tarball.sha256 = '0'.repeat(64))],
		['wrong shebang', (receipt: Receipt) => (receipt.checks.shebang = '#!/usr/bin/env node')],
		['failed executable check', (receipt: Receipt) => (receipt.checks.executable = false)],
		['failed version check', (receipt: Receipt) => (receipt.versionCheck.exitCode = 1)],
		['failed initialize check', (receipt: Receipt) => (receipt.protocolCheck.initialize = false)],
		['failed tools list check', (receipt: Receipt) => (receipt.protocolCheck.toolsList = false)],
		['failed protocol check', (receipt: Receipt) => (receipt.protocolCheck.validCall = false)],
		['failed invalid call check', (receipt: Receipt) => (receipt.protocolCheck.invalidCall = false)],
		['failed shutdown exit', (receipt: Receipt) => (receipt.shutdownCheck.exitCode = 1)],
		['failed shutdown check', (receipt: Receipt) => (receipt.shutdownCheck.outstandingRequests = 1)],
		['failed temp cleanup check', (receipt: Receipt) => (receipt.cleanup.tempRootsRemoved = false)],
		['failed cleanup check', (receipt: Receipt) => (receipt.cleanup.outputPreserved = false)],
	])('rejects receipt metadata with %s', async (_label, mutate) => {
		// Given
		const { root, receipt } = await createArtifact();
		mutate(receipt);
		await writeReceipt(root, receipt);
		// When
		const result = await runImportedValidator(root, sourceSha);
		// Then
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe('');
	});

	it.each([
		[
			'mutated tarball bytes',
			async (root: string) => writeFile(join(root, tarballName), 'mutated release bytes\n'),
		],
		[
			'inconsistent checksum metadata',
			async (root: string) => writeFile(join(root, 'SHA256SUMS'), `${'0'.repeat(64)}  ${tarballName}\n`),
		],
		[
			'inexact checksum syntax',
			async (root: string, receipt: Receipt) =>
				writeFile(join(root, 'SHA256SUMS'), `${receipt.tarball.sha256} ${tarballName}\n`),
		],
	])('rejects artifact bytes with %s', async (_label, mutate) => {
		// Given
		const { root, receipt } = await createArtifact();
		await mutate(root, receipt);
		// When
		const result = await runImportedValidator(root, sourceSha);
		// Then
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe('');
	});
});
