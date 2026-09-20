#!/usr/bin/env node
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackedCliError, appendCleanupDiagnostics } from './packed-cli-cleanup.mjs';
import { cleanupPackedPackage, inspectPackedPackage } from './packed-cli-package.mjs';
import { verifyPackedRuntime } from './packed-cli-runtime.mjs';
import { verifyPackedLibraryApi } from './packed-library-api.mjs';
import {
	verifyBuildCurrentContract,
	verifyPackedCurrentContract,
	verifySourceCurrentContract,
} from './current-contract.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(args) {
	if (args.length === 0) return repositoryRoot;
	if (args.length !== 2 || args[0] !== '--package-dir' || args[1].trim() === '') {
		throw new PackedCliError(
			'ARGUMENTS_INVALID',
			'usage: node scripts/verify-packed-cli.mjs [--package-dir <directory>]'
		);
	}
	return resolve(args[1]);
}

async function requireDirectory(path, contract) {
	let metadata;
	try {
		metadata = await stat(path);
	} catch (error) {
		throw new PackedCliError(contract.code, `${contract.message}: ${error}`);
	}
	if (!metadata.isDirectory()) throw new PackedCliError(contract.code, contract.message);
}

async function prepareOutput(path) {
	try {
		const metadata = await stat(path);
		if (!metadata.isDirectory()) {
			throw new PackedCliError('OUTPUT_DIRECTORY_INVALID', 'pack output path is not a directory');
		}
		if ((await readdir(path)).length !== 0) {
			throw new PackedCliError('OUTPUT_DIRECTORY_NOT_EMPTY', 'pack output directory must be empty');
		}
	} catch (error) {
		if (error instanceof PackedCliError) throw error;
		if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
	}
}

function createReceipt(context) {
	const { artifact, runtime, preserved, sourceSha } = context;
	return {
		schemaVersion: 1,
		sourceSha,
		name: artifact.name,
		version: artifact.version,
		tarball: artifact.tarball,
		packedFiles: artifact.packedFiles,
		manifest: {
			name: artifact.name,
			version: artifact.version,
			...artifact.manifest,
		},
		checks: artifact.checks,
		versionCheck: runtime.version,
		protocolCheck: runtime.protocol,
		shutdownCheck: runtime.shutdown,
		cleanup: { tempRootsRemoved: true, outputPreserved: preserved },
	};
}

async function preserveArtifact(outputDirectory, context) {
	const { artifact, runtime, sourceSha } = context;
	await mkdir(outputDirectory, { recursive: true });
	await copyFile(artifact.tarballPath, resolve(outputDirectory, artifact.tarball.basename));
	await cleanupPackedPackage(artifact);
	const receipt = createReceipt({ artifact, runtime, preserved: true, sourceSha });
	await writeFile(
		resolve(outputDirectory, 'verification.json'),
		`${JSON.stringify(receipt, null, 2)}\n`
	);
	await writeFile(
		resolve(outputDirectory, 'SHA256SUMS'),
		`${artifact.tarball.sha256}  ${artifact.tarball.basename}\n`
	);
	return receipt;
}

async function cleanupFailedRun(artifact, outputDirectory) {
	const operations = [];
	if (artifact) operations.push(cleanupPackedPackage(artifact));
	if (outputDirectory) operations.push(rm(outputDirectory, { recursive: true, force: true }));
	const settled = await Promise.allSettled(operations);
	return settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}

function primaryFailure(error, verificationSucceeded, artifact) {
	if (error instanceof PackedCliError) return error;
	return new PackedCliError(
		verificationSucceeded ? 'PACKED_CLEANUP_FAILED' : 'PACKED_VERIFICATION_FAILED',
		String(error),
		{ packSucceeded: Boolean(artifact), installSucceeded: Boolean(artifact) }
	);
}

async function run() {
	const packageDirectory = parseArguments(process.argv.slice(2));
	await requireDirectory(packageDirectory, {
		code: 'PACKAGE_DIRECTORY_INVALID',
		message: 'package directory is invalid',
	});
	const outputValue = process.env.TRACELATTICE_PACK_OUTPUT_DIR;
	const outputDirectory = outputValue ? resolve(outputValue) : null;
	if (outputDirectory) await prepareOutput(outputDirectory);
	const sourceSha = process.env.TRACELATTICE_SOURCE_SHA || null;
	let artifact;
	let verificationSucceeded = false;
	try {
		await verifySourceCurrentContract(repositoryRoot);
		await verifyBuildCurrentContract(packageDirectory);
		artifact = await inspectPackedPackage(packageDirectory);
		await verifyPackedCurrentContract(artifact.packageRoot);
		await verifyPackedLibraryApi(artifact, repositoryRoot);
		const runtime = await verifyPackedRuntime(artifact);
		verificationSucceeded = true;
		if (outputDirectory) {
			return await preserveArtifact(outputDirectory, { artifact, runtime, sourceSha });
		}
		await cleanupPackedPackage(artifact);
		return createReceipt({ artifact, runtime, preserved: false, sourceSha });
	} catch (error) {
		const primary = primaryFailure(error, verificationSucceeded, artifact);
		const cleanupErrors = await cleanupFailedRun(artifact, outputDirectory);
		throw appendCleanupDiagnostics(primary, cleanupErrors);
	}
}

async function main() {
	try {
		const receipt = await run();
		process.stdout.write(`${JSON.stringify(receipt)}\n`);
	} catch (error) {
		const packedError =
			error instanceof PackedCliError
				? error
				: new PackedCliError('PACKED_VERIFICATION_FAILED', String(error));
		process.stderr.write(`${packedError.code}: ${packedError.message}\n`);
		process.stderr.write(`PACK_SUCCEEDED=${packedError.packSucceeded}\n`);
		process.stderr.write(`INSTALL_SUCCEEDED=${packedError.installSucceeded}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
