import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { ToolAwareSequentialThinkingServer } from '../lib.js';
import { DiscoveryCache } from '../cache/DiscoveryCache.js';
import { Metrics } from '../metrics/metrics.impl.js';
import { FilePersistence } from '../persistence/FilePersistence.js';
import { HttpTransport } from '../transport/HttpTransport.js';
import type { ThoughtData } from '../core/thought.js';
import { asSessionId, asThoughtId } from '../contracts/ids.js';
import { getListeningPort } from './integration/ProtocolHarness.js';

const METRICS_SESSION = asSessionId('metrics-session');

class HttpFixtureError extends Error {
	override readonly name = 'HttpFixtureError';
}

function createMetrics(): Metrics {
	return new Metrics({ prefix: 'sequentialthinking' });
}

function createMockMcpServer(): McpServer {
	return new McpServer(
		{ name: 'metrics-integration-test', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: {
				tools: { listChanged: true },
			},
		}
	);
}

function httpRequest(options: {
	port: number;
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
}): Promise<{ statusCode: number; body: string }> {
	return new Promise((resolve, reject) => {
		let responseEnded = false;
		const req = request(
			{
				hostname: '127.0.0.1',
				port: options.port,
				path: options.path ?? '/messages',
				method: options.method ?? 'POST',
				headers: options.headers,
			},
			(res) => {
				let body = '';
				res.on('data', (chunk) => {
					body += chunk.toString();
				});
				res.once('error', reject);
				res.once('aborted', () => {
					reject(new HttpFixtureError('Response aborted'));
				});
				res.once('close', () => {
					if (!responseEnded || !res.complete) {
						reject(new HttpFixtureError('Response closed before completing'));
					}
				});
				res.on('end', () => {
					responseEnded = true;
					resolve({
						statusCode: res.statusCode ?? 0,
						body,
					});
				});
			}
		);

		req.on('error', reject);
		if (options.body) {
			req.write(options.body);
		}
		req.end();
	});
}

describe('Metrics Integration', () => {
	let server: ToolAwareSequentialThinkingServer;

	beforeEach(async () => {
		server = await ToolAwareSequentialThinkingServer.create({
			maxHistorySize: 100,
			lazyDiscovery: true,
		});
	});

	afterEach(async () => {
		await server.stop();
	});

	it('resolves Metrics from DI container and returns Prometheus format', () => {
		server.getContainer().resolve('Metrics').counter('test_metric_total', 1, {});
		const snapshot = server.getMetricsSnapshot();
		expect(snapshot).toContain('# TYPE');
		expect(snapshot).toContain('sequentialthinking_');
	});

	it('returns the exporter snapshot with escaped label values unchanged', () => {
		const metrics = server.getContainer().resolve('Metrics');
		metrics.counter('snapshot_total', 2, { workflow: 'plan\\review"\nnext' });

		const exported = metrics.export();
		expect(server.getMetricsSnapshot()).toBe(exported);
		expect(exported).toBe(
			'# HELP sequentialthinking_snapshot_total sequentialthinking_snapshot_total metric\n' +
				'# TYPE sequentialthinking_snapshot_total counter\n' +
				'sequentialthinking_snapshot_total{workflow="plan\\\\review\\"\\nnext"} 2'
		);
	});

	it('keeps colliding DI metric series distinct through lookup, export, and reset', () => {
		const metrics = server.getContainer().resolve('Metrics');
		const combinedLabel = { a: '1,b=2' };
		const splitLabels = { a: '1', b: '2' };
		metrics.counter('collision_total', 2, combinedLabel);
		metrics.inc('collision_total', splitLabels);

		expect(metrics.get('collision_total', combinedLabel)).toBe(2);
		expect(metrics.get('collision_total', splitLabels)).toBe(1);
		expect(server.getMetricsSnapshot()).toContain(
			'sequentialthinking_collision_total{a="1,b=2"} 2'
		);
		expect(server.getMetricsSnapshot()).toContain(
			'sequentialthinking_collision_total{a="1",b="2"} 1'
		);

		metrics.reset();
		expect(server.getMetricsSnapshot()).toBe('');
	});

	it('preserves histogram totals and custom buckets with copied labels', () => {
		const metrics = server.getContainer().resolve('Metrics');
		const labels = { operation: 'read' };
		metrics.histogram('custom_latency', 3, labels, [1, 5]);
		metrics.histogram('custom_latency', 7, labels, [1, 5]);
		labels.operation = 'mutated';

		const snapshot = server.getMetricsSnapshot();
		expect(snapshot).toContain('sequentialthinking_custom_latency_sum{operation="read"} 10');
		expect(snapshot).toContain('sequentialthinking_custom_latency_count{operation="read"} 2');
		expect(snapshot).toContain(
			'sequentialthinking_custom_latency_bucket{operation="read",le="1"} 0'
		);
		expect(snapshot).toContain(
			'sequentialthinking_custom_latency_bucket{operation="read",le="5"} 1'
		);
		expect(snapshot).toContain(
			'sequentialthinking_custom_latency_bucket{operation="read",le="+Inf"} 2'
		);
		expect(snapshot).not.toContain('operation="mutated"');
	});

	it('increments thought_requests_total from HistoryManager addThought', async () => {
		const thought: ThoughtData = {
			session_id: METRICS_SESSION,
			thought: 'Test thought',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
		};

		await server.processThought(thought);

		const snapshot = server.getMetricsSnapshot();
		expect(snapshot).toContain('sequentialthinking_thought_requests_total{} 1');
	});

	it('tracks multiple thought requests without double counting', async () => {
		const thoughts: ThoughtData[] = [
			{
				session_id: METRICS_SESSION,
				thought: 'First',
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
			},
			{
				session_id: METRICS_SESSION,
				thought: 'Second',
				thought_number: 2,
				total_thoughts: 3,
				next_thought_needed: true,
			},
			{
				session_id: METRICS_SESSION,
				thought: 'Third',
				thought_number: 3,
				total_thoughts: 3,
				next_thought_needed: false,
			},
		];

		for (const thought of thoughts) {
			await server.processThought(thought);
		}

		const snapshot = server.getMetricsSnapshot();
		expect(snapshot).toContain('sequentialthinking_thought_requests_total{} 3');
	});

	it('collects cache hit and miss counters', () => {
		const metrics = createMetrics();
		const cache = new DiscoveryCache<string>({ metrics });

		expect(cache.get('missing')).toBeNull();
		cache.set('skills', ['commit']);
		expect(cache.get('skills')).toEqual(['commit']);

		const snapshot = metrics.export();
		expect(snapshot).toContain('sequentialthinking_cache_miss_total{} 1');
		expect(snapshot).toContain('sequentialthinking_cache_hit_total{} 1');
	});

	it('collects HTTP request counters and duration histograms', async () => {
		const metrics = createMetrics();
		const transport = new HttpTransport({
			port: 0,
			host: '127.0.0.1',
			enableRateLimit: false,
			metrics,
		});

		try {
			await transport.connect(createMockMcpServer());
			const port = getListeningPort(transport);

			const response = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
			});

			expect(response.statusCode).toBe(200);

			const snapshot = metrics.export();
			expect(snapshot).toContain('sequentialthinking_http_requests_total{} 1');
			expect(snapshot).toContain('sequentialthinking_http_request_duration_seconds_count 1');
		} finally {
			await transport.stop();
		}
	});

	it('records persistence operation durations', async () => {
		const metrics = createMetrics();
		const dataDir = await mkdtemp(join(tmpdir(), 'trace-lattice-metrics-'));
		const persistence = new FilePersistence({ dataDir, metrics });
		const thought: ThoughtData = {
			session_id: METRICS_SESSION,
			id: asThoughtId('metrics-persisted-thought'),
			thought: 'Persist me',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
		};

		await persistence.saveThoughtForSession(METRICS_SESSION, thought);
		await persistence.loadHistoryForSession(METRICS_SESSION);

		const snapshot = metrics.export();
		expect(snapshot).toContain(
			'sequentialthinking_persistence_op_duration_seconds_count{operation="save_thought"} 1'
		);
		expect(snapshot).toContain(
			'sequentialthinking_persistence_op_duration_seconds_count{operation="load_history"} 1'
		);

		await rm(dataDir, { recursive: true, force: true });
	});

	describe('Metrics unit coverage', () => {
		let metrics: Metrics;

		beforeEach(() => {
			metrics = createMetrics();
		});

		it('should merge help text into existing counter that has no help', () => {
			metrics.counter('my_counter', 1, {});
			metrics.counter('my_counter', 1, {}, 'My help text');

			const snapshot = metrics.export();
			expect(snapshot).toContain('sequentialthinking_my_counter');
			expect(metrics.get('my_counter')).toBe(2);
		});

		it('should not duplicate prefix when name already starts with prefix', () => {
			metrics.counter('sequentialthinking_already_prefixed', 1, {});

			const snapshot = metrics.export();
			// Should NOT produce sequentialthinking_sequentialthinking_already_prefixed
			expect(snapshot).toContain('sequentialthinking_already_prefixed{} 1');
			expect(snapshot).not.toContain('sequentialthinking_sequentialthinking_');
		});

		it('should return name as-is when no prefix is set', () => {
			const noPrefix = new Metrics({});
			noPrefix.counter('raw_counter', 5, {});

			const snapshot = noPrefix.export();
			expect(snapshot).toContain('raw_counter{} 5');
		});

		it('should export histogram names from stored metadata', () => {
			metrics.histogram('parse_test', 0.5, {});
			const snapshot = metrics.export();
			expect(snapshot).toContain('sequentialthinking_parse_test_sum');
			expect(snapshot).toContain('sequentialthinking_parse_test_count');
		});

		it('should handle histogram with empty labelStr (no labels)', () => {
			metrics.histogram('no_label_hist', 1.0, {});

			const snapshot = metrics.export();
			// formatMetricLine with empty labelStr should omit braces
			expect(snapshot).toContain('sequentialthinking_no_label_hist_sum 1');
			expect(snapshot).toContain('sequentialthinking_no_label_hist_count 1');
			expect(snapshot).toContain('sequentialthinking_no_label_hist_bucket{le="+Inf"} 1');
		});

		it('should handle histogram with labels in formatMetricLine', () => {
			metrics.histogram('labeled_hist', 0.05, { op: 'read' });

			const snapshot = metrics.export();
			expect(snapshot).toContain('sequentialthinking_labeled_hist_sum{op="read"} 0.05');
			expect(snapshot).toContain('sequentialthinking_labeled_hist_count{op="read"} 1');
			expect(snapshot).toContain('op="read",le="+Inf"');
		});

		it('should update existing histogram buckets for value > boundary', () => {
			// First observation: 0.01 (fits in most buckets)
			metrics.histogram('bucket_test', 0.01, {});
			// Second observation: 100 (exceeds all boundaries except +Inf)
			metrics.histogram('bucket_test', 100, {});

			const snapshot = metrics.export();
			expect(snapshot).toContain('sequentialthinking_bucket_test_count 2');
			// The 0.01 bucket should have count 1 (only first observation fits)
			expect(snapshot).toContain('sequentialthinking_bucket_test_bucket{le="0.01"} 1');
			// +Inf bucket should have count 2 (both observations)
			expect(snapshot).toContain('sequentialthinking_bucket_test_bucket{le="+Inf"} 2');
		});

		it('should dec() a metric that does not yet exist (defaults to 0)', () => {
			metrics.dec('nonexistent_gauge');

			// Should create gauge with value -1 (0 - 1)
			expect(metrics.get('nonexistent_gauge')).toBe(-1);
		});

		it('should export histogram metadata with no labels', () => {
			metrics.histogram('empty_labels_key', 2.5, {});
			const snapshot = metrics.export();
			expect(snapshot).toContain('sequentialthinking_empty_labels_key_sum 2.5');
		});

		it('should export ordinary counter labels', () => {
			metrics.counter('separator_test', 1, { key: 'val' });
			const snapshot = metrics.export();
			expect(snapshot).toContain('sequentialthinking_separator_test{key="val"} 1');
		});

		it('should track operation count across all metric types', () => {
			metrics.reset();
			expect(metrics.getOperationCount()).toBe(0);

			metrics.counter('op_a', 1);
			metrics.gauge('op_b', 5);
			metrics.histogram('op_c', 0.1);
			metrics.inc('op_a');
			metrics.dec('op_b');

			expect(metrics.getOperationCount()).toBe(5);
		});
	});

	describe('Metrics branch coverage', () => {
		let metrics: Metrics;

		beforeEach(() => {
			metrics = createMetrics();
		});

		it('should not overwrite existing help text on counter', () => {
			metrics.counter('c_help', 1, {}, 'Original help');
			metrics.counter('c_help', 1, {}, 'New help');

			const snapshot = metrics.export();
			expect(snapshot).toContain('Original help');
			expect(snapshot).not.toContain('New help');
		});

		it('should preserve gauge help when re-set without help', () => {
			metrics.gauge('g_help', 10, {}, 'Gauge help');
			metrics.gauge('g_help', 20, {});

			const snapshot = metrics.export();
			expect(snapshot).toContain('Gauge help');
			expect(metrics.get('g_help')).toBe(20);
		});

		it('should deduplicate HELP and TYPE lines for same-name counters with different labels', () => {
			metrics.counter('duped', 1, { a: '1' }, 'Duped help');
			metrics.counter('duped', 2, { a: '2' });

			const snapshot = metrics.export();
			// HELP and TYPE should appear only once
			const helpLines = snapshot.split('\n').filter((l: string) => l.startsWith('# HELP'));
			const typeLines = snapshot.split('\n').filter((l: string) => l.startsWith('# TYPE'));
			expect(helpLines).toHaveLength(1);
			expect(typeLines).toHaveLength(1);
		});

		it('should skip histogram TYPE when counter of same name already registered type', () => {
			metrics.counter('shared_name', 1, {});
			metrics.histogram('shared_name', 0.5, {});

			const snapshot = metrics.export();
			// TYPE line should exist only once (from counter)
			const typeLines = snapshot.split('\n').filter((l: string) => l.startsWith('# TYPE'));
			expect(typeLines).toHaveLength(1);
			expect(typeLines[0]).toContain('counter');
		});

		it('should handle histogram with mismatched custom buckets triggering ?? 0 fallback', () => {
			// First call with buckets [1, 5]
			metrics.histogram('custom_bkt', 3, {}, [1, 5]);
			// Second call with different buckets [1, 5, 10] — bucket 10 was not in original map
			metrics.histogram('custom_bkt', 7, {}, [1, 5, 10]);

			const snapshot = metrics.export();
			expect(snapshot).toContain('sequentialthinking_custom_bkt_count 2');
			// Bucket 10: second value 7 <= 10, but bucket didn't exist before → ?? 0 → 0 + 1 = 1
			expect(snapshot).toContain('le="10"} 1');
		});

		it('should use metric help text in export when help is provided on counter', () => {
			metrics.counter('with_help', 1, {}, 'Explicit help text');

			const snapshot = metrics.export();
			expect(snapshot).toContain('# HELP sequentialthinking_with_help Explicit help text');
		});

		it('should use default help text when none provided on counter', () => {
			metrics.counter('no_help', 1, {});

			const snapshot = metrics.export();
			expect(snapshot).toContain(
				'# HELP sequentialthinking_no_help sequentialthinking_no_help metric'
			);
		});

		it('should cover ?? fallback in gauge when help is undefined and no existing metric', () => {
			metrics.gauge('fresh_gauge', 42, {});

			const snapshot = metrics.export();
			expect(snapshot).toContain('sequentialthinking_fresh_gauge{} 42');
		});

		it('should handle constructor with defaultLabels', () => {
			const m = new Metrics({ prefix: 'test', defaultLabels: { env: 'prod' } });
			m.counter('req', 1, {});

			const snapshot = m.export();
			expect(snapshot).toContain('env="prod"');
		});

		it('should handle constructor with no options (defaulting prefix and defaultLabels)', () => {
			const m = new Metrics();
			m.counter('bare', 1, {});

			const snapshot = m.export();
			expect(snapshot).toContain('bare{} 1');
		});

		it('should handle counter with explicit value and labels', () => {
			metrics.counter('explicit', 5, { k: 'v' }, 'explicit help');

			const snapshot = metrics.export();
			expect(snapshot).toContain('sequentialthinking_explicit{k="v"} 5');
		});

		it('should handle get() for existing metric returning value', () => {
			metrics.counter('exists', 7, {});
			expect(metrics.get('exists')).toBe(7);
		});

		it('should handle histogram with labels producing bucket labels with le', () => {
			metrics.histogram('lbl_hist', 0.001, { svc: 'api' }, [0.01, 0.1]);

			const snapshot = metrics.export();
			expect(snapshot).toContain('svc="api",le="0.01"');
			expect(snapshot).toContain('svc="api",le="+Inf"');
		});

		it('should handle second histogram observation where value exceeds all finite boundaries', () => {
			metrics.histogram('exceed', 0.001, {}, [0.01]);
			// Second obs: value 100 > 0.01 → else branch sets bucket to existing ?? 0
			metrics.histogram('exceed', 100, {}, [0.01]);

			const snapshot = metrics.export();
			expect(snapshot).toContain('le="0.01"} 1');
			expect(snapshot).toContain('le="+Inf"} 2');
		});

		it('should trigger ?? 0 in else branch when new boundary exceeds value', () => {
			// First call: buckets [0.01]
			metrics.histogram('else_fallback', 0.005, {}, [0.01]);
			// Second call: buckets [0.001, 0.01] — boundary 0.001 not in original map,
			// and value 0.005 > 0.001 → else branch → get(0.001) is undefined → ?? 0
			metrics.histogram('else_fallback', 0.005, {}, [0.001, 0.01]);

			const snapshot = metrics.export();
			expect(snapshot).toContain('sequentialthinking_else_fallback_count 2');
			expect(snapshot).toContain('le="0.001"} 0');
		});

		it('should trigger ?? 0 on Infinity bucket for second observation', () => {
			// Already tested, but explicitly verifying the Infinity ?? 0 path.
			// First call initializes Infinity=1. Second call: get(Infinity) returns 1 (not undefined).
			// The ?? 0 never triggers for Infinity because it's always initialized.
			// This test ensures consistent behavior.
			metrics.histogram('inf_bkt', 1, {}, [10]);
			metrics.histogram('inf_bkt', 2, {}, [10]);

			const snapshot = metrics.export();
			expect(snapshot).toContain('le="+Inf"} 2');
		});

		it('should handle counter inc() without labels (undefined labels)', () => {
			metrics.inc('inc_nolabel');
			metrics.inc('inc_nolabel');

			expect(metrics.get('inc_nolabel')).toBe(2);
		});

		it('should handle dec() with labels', () => {
			metrics.gauge('dec_with_lbl', 5, { zone: 'a' });
			metrics.dec('dec_with_lbl', { zone: 'a' });

			expect(metrics.get('dec_with_lbl', { zone: 'a' })).toBe(4);
		});

		it('should handle get() returning undefined for nonexistent metric', () => {
			expect(metrics.get('nonexistent')).toBeUndefined();
		});

		it('should handle histogram export with no labels showing le only in bucket', () => {
			metrics.histogram('nolbl', 0.5, {}, [1]);

			const snapshot = metrics.export();
			expect(snapshot).toContain('sequentialthinking_nolbl_bucket{le="1"} 1');
			expect(snapshot).toContain('sequentialthinking_nolbl_bucket{le="+Inf"} 1');
		});

		it('should handle counter without help, then add help on increment', () => {
			// First call: no help
			metrics.counter('late_help', 1, {});
			// Second call: adds help (help truthy, existing.help is undefined)
			metrics.counter('late_help', 1, {}, 'Late help');

			const snapshot = metrics.export();
			expect(snapshot).toContain('Late help');
		});

		it('should handle counter increment without help when no existing help', () => {
			// First call: no help
			metrics.counter('noh_inc', 1, {});
			// Second call: no help (help falsy → short-circuit &&)
			metrics.counter('noh_inc', 1, {});

			expect(metrics.get('noh_inc')).toBe(2);
		});

		it('should handle histogram with labels where HELP/TYPE comes from histogram alone', () => {
			// Only histogram, no counter/gauge → typeEntries.has is false
			metrics.histogram('hist_only', 0.1, { region: 'us' });

			const snapshot = metrics.export();
			expect(snapshot).toContain('# TYPE sequentialthinking_hist_only histogram');
			expect(snapshot).toContain('region="us",le="+Inf"');
		});

		it('should sort labels alphabetically in metric key for dedup', () => {
			// Labels are sorted in the internal key for dedup, but displayed in original order
			metrics.counter('sorted', 1, { z: '1', a: '2' });
			metrics.counter('sorted', 1, { a: '2', z: '1' });

			// Both increments should hit the same metric (key dedup via sorted labels)
			expect(metrics.get('sorted', { z: '1', a: '2' })).toBe(2);
		});

		it('should use default value=1 when counter called with only name', () => {
			// Triggers value=1 default parameter branch
			metrics.counter('default_val');
			expect(metrics.get('default_val')).toBe(1);
		});

		it('should handle gauge called with all params including help', () => {
			metrics.gauge('full_gauge', 99, { tier: 'premium' }, 'Full gauge help');

			const snapshot = metrics.export();
			expect(snapshot).toContain('# HELP sequentialthinking_full_gauge Full gauge help');
			expect(snapshot).toContain('tier="premium"');
		});

		it('should handle NaN bucket boundary in histogram export', () => {
			// NaN is not Infinity and not Number.isFinite → triggers third branch of ternary
			metrics.histogram('nan_bkt', 1, {}, [NaN]);

			const snapshot = metrics.export();
			expect(snapshot).toContain('le="NaN"');
		});
	});
});
