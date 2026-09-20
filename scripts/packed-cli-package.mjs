import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
	PackedCliError,
	appendCleanupDiagnostics,
	removeTemporaryRoots,
} from './packed-cli-cleanup.mjs';

const [COMMAND_TIMEOUT_MS, FORCE_CLOSE_MS] = [120_000, 5_000];
const REQUIRED_FILES = [
	['dist/cli.js', 'PACKED_CLI_MISSING', 'dist/cli.js'],
	['dist/lib.js', 'PACKED_EXPORT_MISSING', '. import'],
	['dist/lib.d.ts', 'PACKED_EXPORT_MISSING', '. types'],
	['package.json', 'PACKED_EXPORT_MISSING', './package.json'],
];

function fail(code, message, stage) {
	throw new PackedCliError(code, message, stage);
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function runCommand(command, args, options) {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env ?? process.env,
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
		throw new PackedCliError(
			options.code,
			`${command} ${args[0]} failed (${status.code ?? status.signal}): ${stderr.trim()}`,
			options.stage
		);
	}
	return stdout;
}

function parsePackResult(stdout, packRoot, stage) {
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new PackedCliError(
			'PACK_RESULT_INVALID',
			`npm pack returned invalid JSON: ${error}`,
			stage
		);
	}
	if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
		fail('PACK_RESULT_INVALID', 'npm pack must return exactly one result', stage);
	}
	const result = parsed[0];
	if (typeof result.filename !== 'string' || typeof result.name !== 'string') {
		fail('PACK_RESULT_INVALID', 'npm pack result is missing filename or name', stage);
	}
	const tarballPath = resolve(packRoot, result.filename);
	if (dirname(tarballPath) !== resolve(packRoot) || !tarballPath.endsWith('.tgz')) {
		fail('PACK_TARBALL_INVALID', 'npm pack tarball escaped the pack root', stage);
	}
	return { result, tarballPath };
}

function inPackageTarget(packageRoot, target, contract) {
	if (typeof target !== 'string' || !target.trim() || isAbsolute(target))
		fail(contract.code, 'target must be relative', contract.stage);
	if (/^(?:[\\/]|[A-Za-z]:)/.test(target))
		fail(contract.code, 'target must be relative', contract.stage);
	if (target.split(/[\\/]+/).includes('..'))
		fail(contract.code, 'target must remain inside the package', contract.stage);
	const normalized = normalize(target.replace(/^\.\//, ''));
	const absolute = resolve(packageRoot, normalized);
	if (!absolute.startsWith(`${resolve(packageRoot)}${sep}`)) {
		fail(contract.code, 'target must remain inside the package', contract.stage);
	}
	return absolute;
}

function readManifestContract(manifest, context) {
	const { packageRoot, packResult, stage } = context;
	if (manifest.name !== '@iworkforces/tracelattice')
		fail('PACKED_NAME_INVALID', 'expected @iworkforces/tracelattice', stage);
	if (typeof manifest.version !== 'string' || manifest.version !== packResult.version) {
		fail('PACKED_VERSION_INVALID', 'pack and installed manifest versions differ', stage);
	}
	const files = manifest.files;
	const filesContract = { code: 'PACKED_FILES_INVALID', stage };
	if (!Array.isArray(files) || !files.includes('dist')) fail(filesContract.code, 'files', stage);
	for (const file of files) inPackageTarget(packageRoot, file, filesContract);
	if (!isRecord(manifest.exports) || !isRecord(manifest.exports['.'])) {
		fail('PACKED_EXPORT_MISSING', '.', stage);
	}
	const rootExport = manifest.exports['.'];
	if (typeof rootExport.import !== 'string') fail('PACKED_EXPORT_MISSING', '. import', stage);
	if (typeof rootExport.types !== 'string') fail('PACKED_EXPORT_MISSING', '. types', stage);
	if (typeof manifest.exports['./package.json'] !== 'string') {
		fail('PACKED_EXPORT_MISSING', './package.json', stage);
	}
	if (!isRecord(manifest.bin) || !Object.hasOwn(manifest.bin, 'tracelattice')) {
		fail('PACKED_BIN_MISSING', 'tracelattice', stage);
	}
	const binTarget = manifest.bin.tracelattice;
	const targets = [
		[manifest.main, 'PACKED_MAIN_MISSING', 'main'],
		[manifest.types, 'PACKED_TYPES_MISSING', 'types'],
		[rootExport.import, 'PACKED_EXPORT_MISSING', '. import'],
		[rootExport.types, 'PACKED_EXPORT_MISSING', '. types'],
		[manifest.exports['./package.json'], 'PACKED_EXPORT_MISSING', './package.json'],
	];
	const targetContracts = targets.map(([target, code, message]) => ({
		path: inPackageTarget(packageRoot, target, { code: 'PACKED_TARGET_INVALID', stage }),
		code,
		message,
	}));
	const binaryPath = inPackageTarget(packageRoot, binTarget, { code: 'PACKED_BIN_INVALID', stage });
	return { binaryPath, targetContracts, files };
}

async function validateFiles(artifact, stage) {
	const files = artifact.result.files;
	if (!Array.isArray(files)) fail('PACK_RESULT_INVALID', 'packed file list is missing', stage);
	const fileNames = files.flatMap((entry) => (typeof entry?.path === 'string' ? [entry.path] : []));
	for (const [path, code, message] of REQUIRED_FILES) {
		if (!fileNames.includes(path)) fail(code, message, stage);
	}
	for (const target of artifact.targetContracts) {
		try {
			await access(target.path, constants.R_OK);
		} catch {
			fail(target.code, target.message, stage);
		}
	}
	const cli = await readFile(artifact.cliTargetPath, 'utf8');
	if (!cli.startsWith('#!/usr/bin/env bun\n')) {
		fail('PACKED_CLI_SHEBANG', 'expected exact #!/usr/bin/env bun shebang', stage);
	}
	try {
		await access(artifact.binaryPath, constants.X_OK);
	} catch {
		fail('PACKED_CLI_MISSING', 'installed .bin/tracelattice', stage);
	}
	return { fileNames: [...fileNames].sort() };
}

export async function inspectPackedPackage(packageDirectory) {
	const stage = { packSucceeded: false, installSucceeded: false };
	const packRoot = await mkdtemp(join(tmpdir(), 'tracelattice-pack-'));
	const consumerRoot = await mkdtemp(join(tmpdir(), 'tracelattice-consumer-'));
	try {
		const userConfig = join(consumerRoot, '.npmrc');
		await writeFile(userConfig, '');
		const npmEnvironment = { ...process.env, NPM_CONFIG_USERCONFIG: userConfig };
		delete npmEnvironment.npm_config_allow_scripts;
		delete npmEnvironment.NPM_CONFIG_ALLOW_SCRIPTS;
		const stdout = await runCommand(
			'npm',
			['pack', resolve(packageDirectory), '--json', '--pack-destination', packRoot],
			{ cwd: consumerRoot, code: 'PACK_COMMAND_FAILED', stage, env: npmEnvironment }
		);
		stage.packSucceeded = true;
		const packed = parsePackResult(stdout, packRoot, stage);
		const tarballs = (await readdir(packRoot)).filter((entry) => entry.endsWith('.tgz'));
		if (tarballs.length !== 1 || resolve(packRoot, tarballs[0]) !== packed.tarballPath) {
			fail('PACK_TARBALL_INVALID', 'npm pack must create exactly one tarball', stage);
		}
		await writeFile(join(consumerRoot, 'package.json'), '{"private":true,"type":"module"}\n');
		await runCommand(
			'npm',
			['install', '--omit=dev', '--no-save', '--package-lock=false', packed.tarballPath],
			{ cwd: consumerRoot, code: 'INSTALL_COMMAND_FAILED', stage, env: npmEnvironment }
		);
		stage.installSucceeded = true;
		const nodeModules = join(consumerRoot, 'node_modules');
		const packageRoot = resolve(nodeModules, ...packed.result.name.split('/'));
		if (!packageRoot.startsWith(`${resolve(nodeModules)}${sep}`))
			fail('PACK_RESULT_INVALID', 'packed package name escaped node_modules', stage);
		const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
		if (!isRecord(manifest))
			fail('PACKED_MANIFEST_INVALID', 'installed manifest is not an object', stage);
		const contract = readManifestContract(manifest, {
			packageRoot,
			packResult: packed.result,
			stage,
		});
		const binaryPath = join(consumerRoot, 'node_modules', '.bin', 'tracelattice');
		const files = await validateFiles(
			{
				...packed,
				packageRoot,
				binaryPath,
				cliTargetPath: contract.binaryPath,
				targetContracts: [
					...contract.targetContracts,
					{ path: contract.binaryPath, code: 'PACKED_CLI_MISSING', message: 'dist/cli.js' },
				],
			},
			stage
		);
		const tarball = await readFile(packed.tarballPath);
		return {
			packRoot,
			consumerRoot,
			packageRoot,
			tarballPath: packed.tarballPath,
			binaryPath,
			name: manifest.name,
			version: manifest.version,
			packedFiles: files.fileNames,
			manifest: {
				files: contract.files,
				main: manifest.main,
				types: manifest.types,
				exports: manifest.exports,
				bin: manifest.bin,
			},
			tarball: {
				basename: basename(packed.tarballPath),
				size: tarball.byteLength,
				sha256: createHash('sha256').update(tarball).digest('hex'),
			},
			checks: { shebang: '#!/usr/bin/env bun', executable: true },
		};
	} catch (error) {
		const primary =
			error instanceof PackedCliError
				? error
				: new PackedCliError('PACKED_ARTIFACT_INVALID', String(error), stage);
		const cleanupErrors = await removeTemporaryRoots([packRoot, consumerRoot]);
		throw appendCleanupDiagnostics(primary, cleanupErrors);
	}
}

export async function cleanupPackedPackage(artifact) {
	const cleanupErrors = await removeTemporaryRoots([artifact.packRoot, artifact.consumerRoot]);
	if (cleanupErrors.length === 0) return;
	const stage = { packSucceeded: true, installSucceeded: true };
	const primary = new PackedCliError('PACKED_CLEANUP_FAILED', 'package cleanup failed', stage);
	throw appendCleanupDiagnostics(primary, cleanupErrors);
}
