import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackedCliError } from './packed-cli-cleanup.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REMOVED_PERSISTENCE_FILES = [
	'FileLegacyImport',
	'SqliteLegacyImport',
	'SqliteLegacySchema',
	'SessionScopedPersistence',
];
const REMOVED_SOURCE_FILES = REMOVED_PERSISTENCE_FILES.map((name) => `src/persistence/${name}.ts`);
const REMOVED_PACKED_FILES = REMOVED_PERSISTENCE_FILES.flatMap((name) =>
	['js', 'js.map', 'd.ts', 'd.ts.map'].map((extension) => `dist/persistence/${name}.${extension}`)
);
const REMOVED_PERSISTENCE_SYMBOLS = [
	'SessionScopedPersistenceBackend',
	'supportsSessionScopedPersistence',
	'importLegacyFileV1',
	'importLegacySqliteV1',
];
const REMOVED_REGISTRY_METHOD =
	/\b(?:addTool|removeTool|updateTool|getTool|getAllTools|hasTool|getToolNames|setTools|addSkill|removeSkill|updateSkill|getSkill|getAllSkills|hasSkill|getSkillNames|setSkills|removeSkillByName)\s*\(/;
const REMOVED_PERSISTENCE_METHOD =
	/\b(?:saveThought|loadHistory|saveBranch|deleteBranch|loadBranch|listBranches)\s*\(/;
const UNPREFIXED_ENV =
	/process\.env\.(?:MAX_HISTORY_SIZE|MAX_BRANCHES|MAX_BRANCH_SIZE|LOG_LEVEL|PRETTY_LOG|SKILL_DIRS|TOOL_DIRS|DISCOVERY_CACHE_TTL|DISCOVERY_CACHE_MAX_SIZE|SESSION_MAX_PER_OWNER|TRANSPORT_TYPE|STREAMABLE_HTTP_PORT|STREAMABLE_HTTP_HOST|STREAMABLE_HTTP_STATEFUL|CORS_ORIGIN|ENABLE_CORS|ALLOWED_HOSTS|WATCHER_VERBOSE)\b/;
const THOUGHT_SESSION_FILES = [
	'schema',
	'core/thought',
	'core/IHistoryManager',
	'core/HistoryManager',
	'core/ThoughtProcessor',
	'lib',
];
const REMOVED_SESSION_SYMBOL = /\bGLOBAL_SESSION_ID\b/;
const RETIRED_SESSION_CONSTRUCTOR = /\basSessionId\s*\(\s*['"]__global__['"]\s*\)/;
const OPTIONAL_THOUGHT_SESSION =
	/\bsession_id\s*\?:|\bsessionId\s*\?:|\bsessionId\s*:\s*(?:string|SessionId)\s*\|\s*undefined|\bgetBranches\s*\(\s*\)\s*(?::|\{)/;
const OPTIONAL_SESSION_SCHEMA =
	/\bsession_id\s*:\s*(?:[\w$.]+\.optional\s*\(|\w+\.OptionalSchema\b)/;
const THOUGHT_SESSION_FALLBACK =
	/\bsessionId\s*(?:\?\?|\|\|)|\bsessionId\s*=\s*['"]|\bDEFAULT_SESSION\b/;
const SNAKE_CASE_SESSION_FALLBACK = /\bsession_id\s*(?:\?\?|\|\|)/;

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
		throw error;
	}
}

async function contractFiles(directory, extensions, skipTests = false) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (skipTests && entry.name === '__tests__') continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await contractFiles(path, extensions, skipTests)));
		else if (extensions.some((extension) => entry.name.endsWith(extension))) files.push(path);
	}
	return files;
}

function fail(code, root, path, detail, stage) {
	throw new PackedCliError(code, `${relative(root, path)}: ${detail}`, stage);
}

async function assertRemovedFiles(root, names, code, stage) {
	for (const name of names) {
		const path = join(root, name);
		if (await exists(path)) fail(code, root, path, 'removed file is present', stage);
	}
}

async function assertFile(path, root, patterns, code, stage) {
	const source = await readFile(path, 'utf8');
	for (const [pattern, detail] of patterns) {
		if (typeof pattern === 'string' ? source.includes(pattern) : pattern.test(source)) {
			fail(code, root, path, detail, stage);
		}
	}
}

export async function verifySourceCurrentContract(repositoryRoot) {
	const stage = { packSucceeded: false, installSucceeded: false };
	await assertRemovedFiles(
		repositoryRoot,
		REMOVED_SOURCE_FILES,
		'SOURCE_CURRENT_CONTRACT_INVALID',
		stage
	);
	for (const path of await contractFiles(join(repositoryRoot, 'src'), ['.ts'], true)) {
		await assertFile(
			path,
			repositoryRoot,
			[
				[UNPREFIXED_ENV, 'unprefixed runtime environment read'],
				[REMOVED_SESSION_SYMBOL, 'removed global session symbol'],
				[RETIRED_SESSION_CONSTRUCTOR, 'retired global session accepted'],
				[SNAKE_CASE_SESSION_FALLBACK, 'implicit thought session fallback'],
				[OPTIONAL_SESSION_SCHEMA, 'optional public thought session declaration'],
			],
			'SOURCE_CURRENT_CONTRACT_INVALID',
			stage
		);
	}
	for (const name of THOUGHT_SESSION_FILES.map((file) => `src/${file}.ts`)) {
		await assertFile(
			join(repositoryRoot, name),
			repositoryRoot,
			[
				[OPTIONAL_THOUGHT_SESSION, 'optional public thought session declaration'],
				[THOUGHT_SESSION_FALLBACK, 'implicit thought session fallback'],
			],
			'SOURCE_CURRENT_CONTRACT_INVALID',
			stage
		);
	}
	const persistencePaths = [
		'src/contracts/PersistenceBackend.ts',
		'src/persistence/FilePersistence.ts',
		'src/persistence/MemoryPersistence.ts',
		'src/persistence/SqlitePersistence.ts',
	];
	for (const name of persistencePaths) {
		await assertFile(
			join(repositoryRoot, name),
			repositoryRoot,
			[
				...REMOVED_PERSISTENCE_SYMBOLS.map((symbol) => [symbol, `removed symbol ${symbol}`]),
				[REMOVED_PERSISTENCE_METHOD, 'unscoped persistence method'],
			],
			'SOURCE_CURRENT_CONTRACT_INVALID',
			stage
		);
	}
	for (const name of [
		'src/registry/ToolRegistry.ts',
		'src/registry/SkillRegistry.ts',
		'src/lib.ts',
	]) {
		await assertFile(
			join(repositoryRoot, name),
			repositoryRoot,
			[[REMOVED_REGISTRY_METHOD, 'removed registry method alias']],
			'SOURCE_CURRENT_CONTRACT_INVALID',
			stage
		);
	}
}

async function verifyBuiltRoot(root, code, stage) {
	await assertRemovedFiles(root, REMOVED_PACKED_FILES, code, stage);
	for (const path of await contractFiles(join(root, 'dist'), ['.js', '.d.ts'])) {
		await assertFile(
			path,
			root,
			[
				[REMOVED_SESSION_SYMBOL, 'removed global session symbol'],
				[RETIRED_SESSION_CONSTRUCTOR, 'retired global session accepted'],
				[SNAKE_CASE_SESSION_FALLBACK, 'implicit thought session fallback'],
				[OPTIONAL_SESSION_SCHEMA, 'optional public thought session declaration'],
			],
			code,
			stage
		);
	}
	for (const name of THOUGHT_SESSION_FILES) {
		for (const extension of ['js', 'd.ts']) {
			const path = join(root, `dist/${name}.${extension}`);
			if (!(await exists(path))) continue;
			await assertFile(
				path,
				root,
				[
					[OPTIONAL_THOUGHT_SESSION, 'optional public thought session declaration'],
					[THOUGHT_SESSION_FALLBACK, 'implicit thought session fallback'],
				],
				code,
				stage
			);
		}
	}
	for (const name of ['dist/lib.js', 'dist/cli.js']) {
		const path = join(root, name);
		if (!(await exists(path))) continue;
		await assertFile(
			path,
			root,
			[[UNPREFIXED_ENV, 'unprefixed runtime environment read']],
			code,
			stage
		);
	}
	for (const name of [
		'dist/contracts/PersistenceBackend.d.ts',
		'dist/contracts/PersistenceBackend.js',
		'dist/persistence/FilePersistence.d.ts',
		'dist/persistence/FilePersistence.js',
		'dist/persistence/MemoryPersistence.d.ts',
		'dist/persistence/MemoryPersistence.js',
		'dist/persistence/SqlitePersistence.d.ts',
		'dist/persistence/SqlitePersistence.js',
	]) {
		const path = join(root, name);
		if (!(await exists(path))) continue;
		await assertFile(
			path,
			root,
			[
				...REMOVED_PERSISTENCE_SYMBOLS.map((symbol) => [symbol, `removed symbol ${symbol}`]),
				[REMOVED_PERSISTENCE_METHOD, 'unscoped persistence method'],
			],
			code,
			stage
		);
	}
	for (const name of [
		'dist/lib.js',
		'dist/lib.d.ts',
		'dist/registry/ToolRegistry.js',
		'dist/registry/ToolRegistry.d.ts',
		'dist/registry/SkillRegistry.js',
		'dist/registry/SkillRegistry.d.ts',
	]) {
		const path = join(root, name);
		if (!(await exists(path))) continue;
		await assertFile(
			path,
			root,
			[[REMOVED_REGISTRY_METHOD, 'removed registry method alias']],
			code,
			stage
		);
	}
}

export async function verifyBuildCurrentContract(buildRoot) {
	await verifyBuiltRoot(buildRoot, 'BUILD_CURRENT_CONTRACT_INVALID', {
		packSucceeded: false,
		installSucceeded: false,
	});
}

export async function verifyPackedCurrentContract(packageRoot) {
	await verifyBuiltRoot(packageRoot, 'PACKED_CURRENT_CONTRACT_INVALID', {
		packSucceeded: true,
		installSucceeded: true,
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await verifySourceCurrentContract(repositoryRoot);
}
