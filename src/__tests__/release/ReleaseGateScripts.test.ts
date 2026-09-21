import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageManifestSchema = v.object({
	name: v.string(),
	bin: v.object({ tracelattice: v.string() }),
	dependencies: v.optional(v.record(v.string(), v.string())),
	devDependencies: v.record(v.string(), v.string()),
	scripts: v.looseObject({
		'test:native': v.string(),
		'verify:library': v.string(),
		'verify:native': v.string(),
		'verify:packed': v.string(),
		'verify:release': v.string(),
		prepublishOnly: v.string(),
	}),
});
const expectedReleaseScripts = {
	'test:native':
		'vitest run --config vitest.config.ts src/__tests__/integration/NativeSqliteConformance.test.ts',
	'verify:library': 'npm run type-check && npm run lint && npm run build && npm run test:coverage',
	'verify:native': 'npm ls better-sqlite3@13.0.3 --depth=0 && npm run test:native',
	'verify:packed': 'node scripts/verify-packed-cli.mjs',
	'verify:release': 'npm run verify:library && npm run verify:native && npm run verify:packed',
	prepublishOnly: 'npm run verify:release',
} as const;
const alternatePublishHooks = [
	'prepublish',
	'prepare',
	'prepack',
	'postpack',
	'publish',
	'postpublish',
] as const;

async function readPackageManifest() {
	const packageContents = await readFile(resolve(projectRoot, 'package.json'), 'utf8');
	return v.parse(packageManifestSchema, JSON.parse(packageContents));
}

async function readPackedVerifier() {
	return readFile(resolve(projectRoot, 'scripts/verify-packed-cli.mjs'), 'utf8');
}

async function readReceiptValidator() {
	return readFile(resolve(projectRoot, 'scripts/validate-release-receipt.mjs'), 'utf8');
}

async function readCurrentContractVerifier() {
	return readFile(resolve(projectRoot, 'scripts/current-contract.mjs'), 'utf8');
}

describe('release gate package scripts', () => {
	it('publishes the scoped package while preserving the public CLI bin', async () => {
		// Given
		const packageManifest = await readPackageManifest();
		// When
		const packageIdentity = { name: packageManifest.name, bin: packageManifest.bin };
		// Then
		expect(packageIdentity).toEqual({
			name: '@iworkforces/tracelattice',
			bin: { tracelattice: './dist/cli.js' },
		});
	});

	it('defines the canonical release-gate command graph', async () => {
		// Given
		const packageManifest = await readPackageManifest();
		// When
		const releaseScripts = {
			'test:native': packageManifest.scripts['test:native'],
			'verify:library': packageManifest.scripts['verify:library'],
			'verify:native': packageManifest.scripts['verify:native'],
			'verify:packed': packageManifest.scripts['verify:packed'],
			'verify:release': packageManifest.scripts['verify:release'],
			prepublishOnly: packageManifest.scripts.prepublishOnly,
		};
		// Then
		expect(releaseScripts).toEqual(expectedReleaseScripts);
	});

	it('requires coverage and native SQLite conformance through && composition', async () => {
		// Given
		const packageManifest = await readPackageManifest();
		const composedScripts = [
			packageManifest.scripts['verify:library'],
			packageManifest.scripts['verify:native'],
			packageManifest.scripts['verify:release'],
		];
		// When
		const libraryGate = packageManifest.scripts['verify:library'];
		// Then
		expect(libraryGate).toContain('npm run test:coverage');
		expect(libraryGate).not.toMatch(/(?:^|&& )npm(?: run)? test(?:$| &&)/);
		expect(composedScripts.every((script) => script.includes(' && '))).toBe(true);
		expect(
			composedScripts.every((script) => !script.includes(' || ') && !script.includes(';'))
		).toBe(true);
		expect(packageManifest.scripts['verify:native']).toContain(
			'npm ls better-sqlite3@13.0.3 --depth=0'
		);
		expect(packageManifest.scripts['test:native']).not.toContain('||');
	});

	it('keeps SQLite development-only and prevents lifecycle bypasses', async () => {
		// Given
		const packageManifest = await readPackageManifest();
		// When
		const alternateHooks = alternatePublishHooks.map((hook) => packageManifest.scripts[hook]);
		// Then
		expect(packageManifest.dependencies?.['better-sqlite3']).toBeUndefined();
		expect(packageManifest.devDependencies['better-sqlite3']).toBe('13.0.3');
		expect(alternateHooks).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it('runs installed library consumers after inspection and before CLI runtime checks', async () => {
		// Given
		const verifierSource = await readPackedVerifier();
		// When
		const inspection = verifierSource.indexOf(
			'artifact = await inspectPackedPackage(packageDirectory)'
		);
		const library = verifierSource.indexOf(
			'await verifyPackedLibraryApi(artifact, repositoryRoot)'
		);
		const runtime = verifierSource.indexOf('await verifyPackedRuntime(artifact)');
		// Then
		expect(inspection).toBeGreaterThan(-1);
		expect(library).toBeGreaterThan(inspection);
		expect(runtime).toBeGreaterThan(library);
	});

	it('validates the preserved artifact before returning the local receipt', async () => {
		// Given
		const verifierSource = await readPackedVerifier();
		// When
		const preservation = verifierSource.indexOf('await preserveArtifact(outputDirectory');
		const validation = verifierSource.indexOf('await validateReleaseReceipt({');
		const returnedReceipt = verifierSource.indexOf('return receipt', validation);
		// Then
		expect(verifierSource).toContain(
			"import { validateReleaseReceipt } from './validate-release-receipt.mjs'"
		);
		expect(preservation).toBeGreaterThan(-1);
		expect(validation).toBeGreaterThan(preservation);
		expect(returnedReceipt).toBeGreaterThan(validation);
	});

	it('keeps the shared receipt validator directly executable', async () => {
		// Given
		const validatorSource = await readReceiptValidator();
		// When
		const directEntryGuard = validatorSource.lastIndexOf(
			'resolve(process.argv[1]) === fileURLToPath(import.meta.url)'
		);
		// Then
		expect(validatorSource).toContain('export async function validateReleaseReceipt');
		expect(directEntryGuard).toBeGreaterThan(-1);
		expect(validatorSource.indexOf('await main()', directEntryGuard)).toBeGreaterThan(-1);
	});

	it('checks the current contract in source, build output, and the installed package', async () => {
		const verifierSource = await readPackedVerifier();

		const source = verifierSource.indexOf('await verifySourceCurrentContract(repositoryRoot)');
		const build = verifierSource.indexOf('await verifyBuildCurrentContract(packageDirectory)');
		const inspection = verifierSource.indexOf(
			'artifact = await inspectPackedPackage(packageDirectory)'
		);
		const packed = verifierSource.indexOf(
			'await verifyPackedCurrentContract(artifact.packageRoot)'
		);

		expect(source).toBeGreaterThan(-1);
		expect(build).toBeGreaterThan(source);
		expect(inspection).toBeGreaterThan(build);
		expect(packed).toBeGreaterThan(inspection);
	});

	it('scopes explicit thought-session checks away from tests and non-thought session APIs', async () => {
		// Given
		const contractSource = await readCurrentContractVerifier();
		// When
		const sourceExclusion = contractSource.includes("entry.name === '__tests__'");
		const scopedFiles = contractSource.includes("'core/ThoughtProcessor'");
		// Then
		expect(sourceExclusion).toBe(true);
		expect(scopedFiles).toBe(true);
		expect(contractSource).not.toContain("'src/transport/");
		expect(contractSource).not.toContain("'src/pool/");
	});

	it('keeps the current-contract verifier directly executable', async () => {
		// Given
		const contractSource = await readCurrentContractVerifier();
		// When
		const directEntryGuard = contractSource.lastIndexOf(
			'resolve(process.argv[1]) === fileURLToPath(import.meta.url)'
		);
		// Then
		expect(directEntryGuard).toBeGreaterThan(-1);
		expect(
			contractSource.indexOf('await verifySourceCurrentContract(repositoryRoot)', directEntryGuard)
		).toBeGreaterThan(-1);
	});
});
