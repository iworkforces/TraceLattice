import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const checkoutAction = 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0';
const setupNodeAction = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
const downloadAction = 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c';
const releaseAction = 'softprops/action-gh-release@718ea10b132b3b2eba29c1007bb80653f286566b';
const artifactDirectory = '${{ runner.temp }}/tracelattice-release';

const scalarSchema = v.union([v.string(), v.number(), v.boolean()]);
const stepSchema = v.looseObject({
	env: v.optional(v.record(v.string(), v.string())),
	id: v.optional(v.string()),
	if: v.optional(v.union([v.string(), v.boolean()])),
	name: v.optional(v.string()),
	run: v.optional(v.string()),
	uses: v.optional(v.string()),
	with: v.optional(v.record(v.string(), scalarSchema)),
	'continue-on-error': v.optional(v.boolean()),
});
const callableJobSchema = v.looseObject({
	uses: v.string(),
	'continue-on-error': v.optional(v.boolean()),
});
const runnerJobSchema = v.looseObject({
	needs: v.optional(v.union([v.string(), v.array(v.string())])),
	'runs-on': v.string(),
	steps: v.array(stepSchema),
	'continue-on-error': v.optional(v.boolean()),
});
const jobSchema = v.union([callableJobSchema, runnerJobSchema]);
const workflowSchema = v.looseObject({
	concurrency: v.looseObject({ group: v.string(), 'cancel-in-progress': v.boolean() }),
	jobs: v.record(v.string(), jobSchema),
	on: v.record(v.string(), v.unknown()),
	permissions: v.record(v.string(), v.string()),
});
const ciSchema = v.looseObject({
	jobs: v.record(
		v.string(),
		v.looseObject({ needs: v.optional(v.union([v.string(), v.array(v.string())])) })
	),
	on: v.record(v.string(), v.unknown()),
});

type Workflow = v.InferOutput<typeof workflowSchema>;
type RunnerJob = v.InferOutput<typeof runnerJobSchema>;
type Step = v.InferOutput<typeof stepSchema>;

async function readYaml(path: string): Promise<unknown> {
	return parse(await readFile(resolve(projectRoot, path), 'utf8'));
}

async function readWorkflow(): Promise<Workflow> {
	return v.parse(workflowSchema, await readYaml('.github/workflows/cd.yml'));
}

function getPublish(workflow: Workflow): RunnerJob {
	return v.parse(runnerJobSchema, workflow.jobs['publish']);
}

function getStepByName(job: RunnerJob, name: string): Step {
	return v.parse(
		stepSchema,
		job.steps.find((step) => step.name === name)
	);
}

describe('CD workflow verified artifact policy', () => {
	it('preserves the protected main release trigger and permissions', async () => {
		// Given
		const workflow = await readWorkflow();
		// When
		const jobNames = Object.keys(workflow.jobs).sort();
		// Then
		expect(workflow.on).toEqual({ push: { branches: ['main'] } });
		expect(workflow.concurrency).toEqual({
			group: 'cd-${{ github.workflow }}',
			'cancel-in-progress': false,
		});
		expect(workflow.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
		expect(jobNames).toEqual(['gates', 'publish']);
	});

	it('waits on the local reusable CI workflow containing required-gates', async () => {
		// Given
		const workflow = await readWorkflow();
		const ci = v.parse(ciSchema, await readYaml('.github/workflows/ci.yml'));
		// When
		const gates = v.parse(callableJobSchema, workflow.jobs['gates']);
		const publish = getPublish(workflow);
		// Then
		expect(gates.uses).toBe('./.github/workflows/ci.yml');
		expect(publish.needs).toBe('gates');
		expect(ci.on).toHaveProperty('workflow_call');
		expect(ci.jobs['required-gates']?.needs).toEqual(['library', 'native-sqlite', 'packed-cli']);
	});

	it('pins checkout, Node, artifact download, and release actions', async () => {
		// Given
		const publish = getPublish(await readWorkflow());
		// When
		const actions = publish.steps.flatMap((step) => (step.uses === undefined ? [] : [step]));
		// Then
		expect(actions.map((step) => step.uses)).toEqual([
			checkoutAction,
			setupNodeAction,
			downloadAction,
			releaseAction,
		]);
		expect(actions.every((step) => /@[0-9a-f]{40}$/.test(step.uses ?? ''))).toBe(true);
		expect(actions[0]?.with).toMatchObject({ ref: '${{ github.sha }}' });
		expect(actions[1]?.with).toEqual({
			'node-version': 24,
			cache: 'npm',
			'registry-url': 'https://registry.npmjs.org',
		});
		expect(actions[2]?.with).toEqual({
			name: 'tracelattice-release-${{ github.sha }}',
			path: artifactDirectory,
		});
	});
});

describe('CD workflow artifact verification policy', () => {
	it('checks the digest before the shared validator and registry access', async () => {
		// Given
		const publish = getPublish(await readWorkflow());
		// When
		const checksumIndex = publish.steps.findIndex((step) => step.name === 'Verify checksum');
		const artifactIndex = publish.steps.findIndex((step) => step.id === 'artifact');
		const registryIndex = publish.steps.findIndex((step) => step.id === 'check');
		const publishIndex = publish.steps.findIndex((step) => step.id === 'publish');
		const artifact = v.parse(stepSchema, publish.steps[artifactIndex]);
		// Then
		expect(checksumIndex).toBeGreaterThan(0);
		expect(checksumIndex).toBeLessThan(artifactIndex);
		expect(artifactIndex).toBeLessThan(registryIndex);
		expect(registryIndex).toBeLessThan(publishIndex);
		expect(publish.steps[checksumIndex]?.run).toContain('sha256sum --check --strict SHA256SUMS');
		expect(artifact.env).toEqual({
			ARTIFACT_DIR: artifactDirectory,
			EXPECTED_SHA: '${{ github.sha }}',
		});
		expect(artifact.run).toBe(
			'node scripts/validate-release-receipt.mjs >> "$GITHUB_OUTPUT"'
		);
		expect(artifact.run).not.toContain("<<'NODE'");
	});

	it('never rebuilds or tests in publish', async () => {
		// Given
		const publish = getPublish(await readWorkflow());
		// When
		const commands = publish.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));
		// Then
		expect(commands.join('\n')).not.toMatch(/npm (?:ci|install|pack)|npm run|npm test/);
		expect(commands.join('\n')).not.toMatch(/\b(?:build|repack)\b/);
		expect(commands.join('\n')).not.toContain('require("./package.json")');
	});
});

describe('CD workflow publication policy', () => {
	it('checks the raw receipt version and publishes only its tarball', async () => {
		// Given
		const publish = getPublish(await readWorkflow());
		// When
		const check = getStepByName(publish, 'Check if version already published');
		const publishStep = getStepByName(publish, 'Publish to npm');
		// Then
		expect(check.run).toContain(
			'npm view "@iworkforces/tracelattice@${{ steps.artifact.outputs.version }}" version'
		);
		expect(check.run).toContain('published=true');
		expect(check.run).toContain('published=false');
		expect(publishStep.run).toBe(
			'npm publish "${{ steps.artifact.outputs.tarball }}" --ignore-scripts --provenance --access public'
		);
		expect(publishStep.if).toBe("steps.check.outputs.published == 'false'");
		expect(publishStep.env).toEqual({ NODE_AUTH_TOKEN: '${{ secrets.NPM_PUBLISH_KEY }}' });
		expect(publish.steps.filter((step) => step.env?.['NODE_AUTH_TOKEN'] !== undefined)).toEqual([
			publishStep,
		]);
	});

	it('creates the annotated receipt-derived tag and release only after publication', async () => {
		// Given
		const publish = getPublish(await readWorkflow());
		// When
		const conditional = publish.steps.filter((step) => step.if !== undefined);
		const tag = getStepByName(publish, 'Create git tag');
		const release = publish.steps.find((step) => step.uses === releaseAction);
		const afterPublish =
			"steps.check.outputs.published == 'false' && steps.publish.outcome == 'success'";
		// Then
		expect(conditional.map((step) => step.if)).toEqual([
			"steps.check.outputs.published == 'false'",
			afterPublish,
			afterPublish,
			afterPublish,
		]);
		expect(tag.run).toContain('git tag -a "${{ steps.artifact.outputs.tag }}"');
		expect(tag.run).toContain('git push origin "${{ steps.artifact.outputs.tag }}"');
		expect(release?.with).toMatchObject({ tag_name: '${{ steps.artifact.outputs.tag }}' });
	});

	it('does not hide required failures', async () => {
		// Given
		const workflow = await readWorkflow();
		// When
		const jobs = Object.values(workflow.jobs);
		const steps = jobs.flatMap((job) => {
			const parsed = v.safeParse(runnerJobSchema, job);
			return parsed.success ? parsed.output.steps : [];
		});
		// Then
		expect(jobs.every((job) => job['continue-on-error'] === undefined)).toBe(true);
		expect(steps.every((step) => step['continue-on-error'] === undefined)).toBe(true);
	});
});
