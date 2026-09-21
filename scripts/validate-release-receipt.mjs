#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_RECEIPT_BYTES = 1_048_576;
const EXPECTED_NAME = '@iworkforces/tracelattice';
const EXPECTED_PACKED_FILES = [
	'package.json',
	'dist/cli.js',
	'dist/lib.js',
	'dist/lib.d.ts',
];
const VERSION_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const TARBALL_SHA_PATTERN = /^[0-9a-f]{64}$/;

function fail(message) {
	throw new Error(message);
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(path) {
	return (
		typeof path === 'string' &&
		path.trim() !== '' &&
		!/^(?:[\\/]|[A-Za-z]:)/.test(path) &&
		!/[\0\r\n]/.test(path) &&
		!path.split(/[\\/]/).includes('..')
	);
}

function hasDuplicates(values) {
	return new Set(values).size !== values.length;
}

async function requireRegularFile(path, label) {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular file`);
	return metadata;
}

function validateReceiptContract(receipt, expectedSourceSha) {
	if (!isRecord(receipt)) fail('receipt must be an object');
	const { tarball, checks, versionCheck, protocolCheck, shutdownCheck, cleanup, manifest } =
		receipt;
	if (![tarball, checks, versionCheck, protocolCheck, shutdownCheck, cleanup, manifest].every(isRecord)) {
		fail('receipt sections are invalid');
	}
	const version = receipt.version;
	if (receipt.schemaVersion !== 1 || receipt.sourceSha !== expectedSourceSha) {
		fail('receipt sourceSha is invalid');
	}
	if (receipt.name !== EXPECTED_NAME || typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
		fail('receipt package identity is invalid');
	}
	if (manifest.name !== receipt.name || manifest.version !== version) {
		fail('receipt manifest is inconsistent');
	}
	if (manifest.main !== 'dist/lib.js' || manifest.types !== 'dist/lib.d.ts') {
		fail('receipt manifest entrypoints are invalid');
	}
	const packageExports = manifest.exports;
	const rootExport = isRecord(packageExports) ? packageExports['.'] : null;
	if (
		!isRecord(rootExport) ||
		rootExport.import !== './dist/lib.js' ||
		rootExport.types !== './dist/lib.d.ts' ||
		packageExports['./package.json'] !== './package.json'
	) {
		fail('receipt manifest exports are invalid');
	}
	const bin = manifest.bin;
	if (!isRecord(bin) || bin.tracelattice !== './dist/cli.js') {
		fail('receipt manifest bin is invalid');
	}
	const files = manifest.files;
	if (
		!Array.isArray(files) ||
		files.length === 0 ||
		!files.includes('dist') ||
		!files.every(isSafeRelativePath) ||
		hasDuplicates(files)
	) {
		fail('receipt manifest files are invalid');
	}
	const packedFiles = receipt.packedFiles;
	if (
		!Array.isArray(packedFiles) ||
		!packedFiles.every(isSafeRelativePath) ||
		hasDuplicates(packedFiles) ||
		!EXPECTED_PACKED_FILES.every((file) => packedFiles.includes(file))
	) {
		fail('receipt packedFiles are invalid');
	}
	const expectedBasename = `iworkforces-tracelattice-${version}.tgz`;
	if (
		tarball.basename !== expectedBasename ||
		basename(tarball.basename) !== tarball.basename ||
		!isSafeRelativePath(tarball.basename)
	) {
		fail('tarball basename is invalid');
	}
	if (!Number.isSafeInteger(tarball.size) || tarball.size <= 0) {
		fail('tarball size metadata is invalid');
	}
	if (typeof tarball.sha256 !== 'string' || !TARBALL_SHA_PATTERN.test(tarball.sha256)) {
		fail('tarball.sha256 metadata is invalid');
	}
	if (checks.shebang !== '#!/usr/bin/env bun' || checks.executable !== true) {
		fail('CLI file checks failed');
	}
	if (versionCheck.exitCode !== 0 || versionCheck.output !== `tracelattice v${version}`) {
		fail('versionCheck failed');
	}
	if (
		protocolCheck.initialize !== true ||
		protocolCheck.toolsList !== true ||
		protocolCheck.validCall !== true ||
		protocolCheck.invalidCall !== true
	) {
		fail('protocolCheck failed');
	}
	if (
		shutdownCheck.exitCode !== 0 ||
		shutdownCheck.signal !== null ||
		shutdownCheck.outstandingRequests !== 0
	) {
		fail('shutdownCheck failed');
	}
	if (cleanup.tempRootsRemoved !== true || cleanup.outputPreserved !== true) {
		fail('cleanup checks failed');
	}
	return { version, tarball };
}

export async function validateReleaseReceipt({ artifactDirectory, expectedSourceSha }) {
	if (
		typeof artifactDirectory !== 'string' ||
		!isAbsolute(artifactDirectory) ||
		/[\0\r\n]/.test(artifactDirectory)
	) {
		fail('artifactDirectory must be an absolute path without control characters');
	}
	if (
		expectedSourceSha !== null &&
		(typeof expectedSourceSha !== 'string' || !SOURCE_SHA_PATTERN.test(expectedSourceSha))
	) {
		fail('expectedSourceSha must be lowercase 40-hex or null');
	}
	const rootMetadata = await lstat(artifactDirectory);
	if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
		fail('artifactDirectory must be a real directory');
	}
	const artifactRoot = resolve(artifactDirectory);
	const entries = await readdir(artifactRoot);
	const tarballs = entries.filter((entry) => entry.endsWith('.tgz'));
	if (entries.length !== 3 || tarballs.length !== 1) {
		fail('artifactDirectory entries are invalid');
	}
	const receiptPath = resolve(artifactRoot, 'verification.json');
	const checksumPath = resolve(artifactRoot, 'SHA256SUMS');
	const receiptMetadata = await requireRegularFile(receiptPath, 'verification.json');
	await requireRegularFile(checksumPath, 'SHA256SUMS');
	if (receiptMetadata.size > MAX_RECEIPT_BYTES) fail('verification.json is too large');
	let receipt;
	try {
		receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
	} catch (error) {
		fail(`verification.json is invalid: ${error}`);
	}
	const validated = validateReceiptContract(receipt, expectedSourceSha);
	if (tarballs[0] !== validated.tarball.basename) {
		fail('tarball.basename does not match the downloaded .tgz');
	}
	const expectedEntries = ['SHA256SUMS', 'verification.json', validated.tarball.basename].sort();
	if (entries.sort().some((entry, index) => entry !== expectedEntries[index])) {
		fail('artifactDirectory entries are invalid');
	}
	const tarballPath = resolve(artifactRoot, validated.tarball.basename);
	const tarballMetadata = await requireRegularFile(tarballPath, validated.tarball.basename);
	if (tarballMetadata.size !== validated.tarball.size) fail('tarball size metadata is invalid');
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(tarballPath)) hash.update(chunk);
	if (hash.digest('hex') !== validated.tarball.sha256) {
		fail('tarball bytes do not match sha256 metadata');
	}
	const checksum = await readFile(checksumPath, 'utf8');
	if (checksum !== `${validated.tarball.sha256}  ${validated.tarball.basename}\n`) {
		fail('SHA256SUMS metadata is inconsistent');
	}
	return {
		version: validated.version,
		tag: `v${validated.version}`,
		tarball: tarballPath,
	};
}

async function main() {
	try {
		const artifactDirectory = process.env.ARTIFACT_DIR;
		const expectedSourceSha = process.env.EXPECTED_SHA;
		if (!artifactDirectory || !isAbsolute(artifactDirectory)) fail('ARTIFACT_DIR is invalid');
		if (!expectedSourceSha || !SOURCE_SHA_PATTERN.test(expectedSourceSha)) {
			fail('EXPECTED_SHA is invalid');
		}
		const result = await validateReleaseReceipt({ artifactDirectory, expectedSourceSha });
		process.stdout.write(
			`version=${result.version}\ntag=${result.tag}\ntarball=${result.tarball}\n`
		);
	} catch (error) {
		process.stderr.write(`RELEASE_RECEIPT_INVALID: ${error}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
