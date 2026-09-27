import { describe, it, expect, beforeEach } from 'vitest';
import { Metrics } from '../metrics.impl.js';

describe('Metrics', () => {
	let metrics: Metrics;

	beforeEach(() => {
		metrics = new Metrics({ prefix: 'test' });
	});

	describe('Counters', () => {
		it('should create and increment counters', () => {
			metrics.counter('requests_total', 1, { method: 'GET' });
			metrics.counter('requests_total', 1, { method: 'POST' });

			expect(metrics.get('requests_total', { method: 'GET' })).toBe(1);
			expect(metrics.get('requests_total', { method: 'POST' })).toBe(1);
		});

		it('should increment counter by 1 when using inc()', () => {
			metrics.inc('requests_total', { method: 'GET' });
			expect(metrics.get('requests_total', { method: 'GET' })).toBe(1);
		});
	});

	describe('Gauges', () => {
		it('should set gauge values', () => {
			metrics.gauge('active_connections', 5);
			metrics.gauge('active_connections', 3);

			expect(metrics.get('active_connections')).toBe(3);
		});

		it('should increment gauge by 1 when using inc()', () => {
			metrics.gauge('active_connections', 5);
			metrics.inc('active_connections');
			expect(metrics.get('active_connections')).toBe(6);
		});

		it('should decrement gauge by 1 when using dec()', () => {
			metrics.gauge('active_connections', 5);
			metrics.dec('active_connections');
			expect(metrics.get('active_connections')).toBe(4);
		});
	});

	describe('Histograms', () => {
		it('should record histogram observations', () => {
			metrics.histogram('request_duration_seconds', 0.01);
			metrics.histogram('request_duration_seconds', 0.1);
			metrics.histogram('request_duration_seconds', 0.5);
			metrics.histogram('request_duration_seconds', 2.5);

			expect(metrics.getOperationCount()).toBe(4);
		});

		it('should bucket values correctly', () => {
			metrics.histogram('test_ms', 0.023);
			metrics.histogram('test_ms', 0.047);
			metrics.histogram('test_ms', 0.153);
			metrics.histogram('test_ms', 1.235);

			const exported = metrics.export();
			expect(exported).toContain('test_ms_bucket{le="0.005"} 0');
			expect(exported).toContain('test_ms_bucket{le="0.025"} 1');
			expect(exported).toContain('test_ms_bucket{le="0.1"} 2');
			expect(exported).toContain('test_ms_bucket{le="+Inf"} 4');
		});

		it('rejects invalid boundaries before creating or changing a series', () => {
			const invalidLayouts = [[NaN], [Infinity], [-Infinity], [2, 1], [1, 1]];
			for (const layout of invalidLayouts) {
				expect(() => metrics.histogram('latency', 3, {}, layout)).toThrow();
				expect(metrics.export()).toBe('');
				expect(metrics.getOperationCount()).toBe(0);
			}

			metrics.histogram('latency', 2, {}, [1, 5]);
			const snapshot = metrics.export();
			for (const layout of invalidLayouts) {
				expect(() => metrics.histogram('latency', 3, {}, layout)).toThrow();
				expect(metrics.export()).toBe(snapshot);
				expect(metrics.getOperationCount()).toBe(1);
			}
		});

		it('keeps copied layouts stable for merged-label series and resets the contract', () => {
			metrics = new Metrics({ prefix: 'test', defaultLabels: { env: 'prod' } });
			const boundaries = [1, 5];
			metrics.histogram('latency', 2, { route: 'a' }, boundaries);
			boundaries[0] = 0;
			metrics.histogram('latency', 4, { route: 'a', env: 'prod' }, [1, 5]);
			metrics.histogram('latency', 7, { route: 'b' }, [2, 10]);
			const snapshot = metrics.export();
			expect(snapshot).toContain('test_latency_bucket{env="prod",route="a",le="5"} 2');
			expect(snapshot).toContain('test_latency_bucket{env="prod",route="a",le="+Inf"} 2');
			expect(snapshot).toContain('test_latency_bucket{env="prod",route="b",le="10"} 1');
			expect(() => metrics.histogram('latency', 3, { route: 'a' }, boundaries)).toThrow();
			expect(() => metrics.histogram('latency', 3, { route: 'a' }, [1, 5, 10])).toThrow();
			expect(metrics.export()).toBe(snapshot);
			expect(metrics.getOperationCount()).toBe(3);

			metrics.reset();
			metrics.histogram('latency', 3, { route: 'a' }, [2]);
			expect(metrics.export()).toContain('test_latency_bucket{env="prod",route="a",le="2"} 0');
			expect(metrics.getOperationCount()).toBe(1);
		});

		it('treats an omitted layout as default on every observation', () => {
			metrics.histogram('default', 0.01);
			const snapshot = metrics.export();
			expect(() => metrics.histogram('default', 0.02, {}, [0.01, 0.1])).toThrow();
			expect(metrics.export()).toBe(snapshot);
			expect(metrics.getOperationCount()).toBe(1);
			metrics.histogram('default', 0.02);
			expect(metrics.export()).toContain('test_default_bucket{le="0.025"} 2');
			metrics.histogram('custom', 1, {}, [2]);
			const customSnapshot = metrics.export();
			expect(() => metrics.histogram('custom', 1)).toThrow();
			expect(metrics.export()).toBe(customSnapshot);
			expect(metrics.getOperationCount()).toBe(3);
		});

		it('exports an empty layout with only the implicit infinite bucket', () => {
			metrics.histogram('empty', 4, {}, []);
			metrics.histogram('empty', 5, {}, []);
			expect(metrics.export()).toContain('test_empty_bucket{le="+Inf"} 2');
			expect(metrics.export().match(/test_empty_bucket/g)).toHaveLength(1);
		});
	});

	describe('Labels', () => {
		it('should apply default labels to all metrics', () => {
			metrics.counter('requests_total', 1);

			expect(metrics.get('requests_total')).toBe(1);
			expect(metrics.get('requests_total', { custom: 'label' })).toBeUndefined();
		});

		it('should merge default labels with provided labels', () => {
			metrics = new Metrics({ prefix: 'test', defaultLabels: { env: 'prod' } });
			metrics.counter('requests_total', 1, { method: 'GET' });

			expect(metrics.get('requests_total', { method: 'GET', env: 'prod' })).toBe(1);
		});

		it('keeps delimiter-colliding label sets distinct for every metric type', () => {
			const adversarialValue = '2{brace}"quote\\slash\nline';
			const escapedAdversarialValue = '2{brace}\\"quote\\\\slash\\nline';
			const combinedLabel = { a: `1,b=${adversarialValue}` };
			const splitLabels = { a: '1', b: adversarialValue };

			metrics.counter('collision_counter', 2, combinedLabel);
			metrics.counter('collision_counter', 3, splitLabels);
			metrics.gauge('collision_gauge', 5, combinedLabel);
			metrics.gauge('collision_gauge', 7, splitLabels);
			metrics.histogram('collision_histogram', 1, combinedLabel, [1, 2]);
			metrics.histogram('collision_histogram', 2, splitLabels, [1, 2]);

			expect(metrics.get('collision_counter', combinedLabel)).toBe(2);
			expect(metrics.get('collision_counter', splitLabels)).toBe(3);
			expect(metrics.get('collision_gauge', combinedLabel)).toBe(5);
			expect(metrics.get('collision_gauge', splitLabels)).toBe(7);

			const exported = metrics.export();
			expect(exported).toContain(
				`test_collision_histogram_sum{a="1,b=${escapedAdversarialValue}"} 1`
			);
			expect(exported).toContain(
				`test_collision_histogram_sum{a="1",b="${escapedAdversarialValue}"} 2`
			);
			expect(exported).toContain(
				`test_collision_histogram_count{a="1,b=${escapedAdversarialValue}"} 1`
			);
			expect(exported).toContain(
				`test_collision_histogram_count{a="1",b="${escapedAdversarialValue}"} 1`
			);
		});

		it('deduplicates equivalent reordered labels for get, inc, dec, and histogram', () => {
			metrics.counter('ordered_counter', 1, { z: 'last', a: 'first' });
			metrics.inc('ordered_counter', { a: 'first', z: 'last' });
			metrics.gauge('ordered_gauge', 5, { z: 'last', a: 'first' });
			metrics.dec('ordered_gauge', { a: 'first', z: 'last' });
			metrics.histogram('ordered_histogram', 1, { z: 'last', a: 'first' }, [1, 2]);
			metrics.histogram('ordered_histogram', 2, { a: 'first', z: 'last' }, [1, 2]);

			expect(metrics.get('ordered_counter', { a: 'first', z: 'last' })).toBe(2);
			expect(metrics.get('ordered_gauge', { z: 'last', a: 'first' })).toBe(4);

			const exported = metrics.export();
			expect(exported).toContain('test_ordered_histogram_sum{z="last",a="first"} 3');
			expect(exported).toContain('test_ordered_histogram_count{z="last",a="first"} 2');
			expect(exported.match(/test_ordered_histogram_sum/g)).toHaveLength(1);
		});

		it('deduplicates reordered Unicode-collation-equivalent label names', () => {
			const precomposed = '\u00e9';
			const decomposed = 'e\u0301';
			const firstLabels = { [precomposed]: 'precomposed', [decomposed]: 'decomposed' };
			const reorderedLabels = { [decomposed]: 'decomposed', [precomposed]: 'precomposed' };

			metrics.counter('unicode_counter', 1, firstLabels);
			metrics.counter('unicode_counter', 2, reorderedLabels);

			expect(metrics.get('unicode_counter', reorderedLabels)).toBe(3);

			const exported = metrics.export();
			expect(exported).toContain(
				`test_unicode_counter{${precomposed}="precomposed",${decomposed}="decomposed"} 3`
			);
			expect(exported.match(/test_unicode_counter\{/g)).toHaveLength(1);
		});

		it('copies constructor defaults and per-record labels while preserving overrides', () => {
			const defaultLabels = { env: 'prod', region: 'us' };
			const counterLabels = { route: 'before' };
			const gaugeLabels = { state: 'before' };
			const histogramLabels = { operation: 'before' };
			metrics = new Metrics({ prefix: 'test', defaultLabels });

			metrics.counter('copied_counter', 1, counterLabels);
			metrics.gauge('copied_gauge', 2, gaugeLabels);
			metrics.histogram('copied_histogram', 0.5, histogramLabels, [1]);
			metrics.counter('override_counter', 3, { env: 'staging' });
			defaultLabels.env = 'dev';
			counterLabels.route = 'after';
			gaugeLabels.state = 'after';
			histogramLabels.operation = 'after';
			metrics.counter('after_default_mutation', 4);

			const exported = metrics.export();
			expect(exported).toContain('env="prod",region="us",route="before"');
			expect(exported).toContain('env="prod",region="us",state="before"');
			expect(exported).toContain('env="prod",region="us",operation="before"');
			expect(exported).toContain('test_override_counter{env="staging",region="us"} 3');
			expect(exported).toContain('test_after_default_mutation{env="prod",region="us"} 4');
			expect(exported).not.toContain('env="dev"');
			expect(exported).not.toContain('="after"');
		});
	});

	describe('Export', () => {
		it('should export in Prometheus text format', () => {
			metrics.counter('test_counter', 42);
			metrics.gauge('test_gauge', 7);
			metrics.histogram('test_histogram', 0.5);

			const exported = metrics.export();

			expect(exported).toContain('# HELP test_counter');
			expect(exported).toContain('# HELP test_gauge');
			expect(exported).toContain('# TYPE test_histogram histogram');
			expect(exported).toContain('test_counter{} 42');
			expect(exported).toContain('test_gauge{} 7');
			expect(exported).toMatch(/test_histogram_sum/);
			expect(exported).toMatch(/test_histogram_count/);
			expect(exported).toMatch(/test_histogram_bucket\{/);
		});

		it('should handle empty metrics', () => {
			metrics = new Metrics({ prefix: 'test' });
			const exported = metrics.export();

			expect(exported).toBe('');
		});

		it('should handle histogram buckets correctly', () => {
			metrics.histogram('latency_ms', 0.023);
			metrics.histogram('latency_ms', 0.047);

			const exported = metrics.export();
			expect(exported).toContain('latency_ms_bucket{le="0.005"} 0');
			expect(exported).toContain('latency_ms_bucket{le="0.05"} 2');
			expect(exported).toContain('latency_ms_bucket{le="+Inf"} 2');
		});

		it('escapes label values identically for counters, gauges, and every histogram sample', () => {
			const labels = { value: 'comma,value={path}\\segment"quoted\nnext' };
			const escapedLabel = 'value="comma,value={path}\\\\segment\\"quoted\\nnext"';

			metrics.counter('escaped_counter', 2, labels);
			metrics.gauge('escaped_gauge', 3, labels);
			metrics.histogram('escaped_histogram', 0.5, labels, [1]);

			const exported = metrics.export();
			expect(exported).toContain(`test_escaped_counter{${escapedLabel}} 2`);
			expect(exported).toContain(`test_escaped_gauge{${escapedLabel}} 3`);
			expect(exported).toContain(`test_escaped_histogram_sum{${escapedLabel}} 0.5`);
			expect(exported).toContain(`test_escaped_histogram_count{${escapedLabel}} 1`);
			expect(exported).toContain(`test_escaped_histogram_bucket{${escapedLabel},le="1"} 1`);
			expect(exported).toContain(`test_escaped_histogram_bucket{${escapedLabel},le="+Inf"} 1`);
			expect(exported).not.toContain('\nnext');
		});

		it('preserves arithmetic with valid custom finite buckets', () => {
			metrics.counter('numeric_counter', 2.5);
			metrics.counter('numeric_counter', -0.5);
			metrics.gauge('numeric_gauge', -3);
			metrics.dec('numeric_gauge');
			metrics.histogram('numeric_histogram', 0.5, {}, [1, 3]);
			metrics.histogram('numeric_histogram', 2, {}, [1, 3]);

			expect(metrics.get('numeric_counter')).toBe(2);
			expect(metrics.get('numeric_gauge')).toBe(-4);
			expect(metrics.getOperationCount()).toBe(6);

			const exported = metrics.export();
			expect(exported).toContain('test_numeric_histogram_sum 2.5');
			expect(exported).toContain('test_numeric_histogram_count 2');
			expect(exported).toContain('test_numeric_histogram_bucket{le="1"} 1');
			expect(exported).toContain('test_numeric_histogram_bucket{le="3"} 2');
			expect(exported).toContain('test_numeric_histogram_bucket{le="+Inf"} 2');
		});

		it('escapes backslashes and newlines in counter and gauge HELP', () => {
			metrics.counter('counter_help', 1, {}, 'line\\path\nnext');
			metrics.gauge('gauge_help', 2, {}, 'gauge\\path\nnext');
			const exported = metrics.export();
			expect(exported).toContain('# HELP test_counter_help line\\\\path\\nnext\n');
			expect(exported).toContain('# HELP test_gauge_help gauge\\\\path\\nnext\n');
		});
	});

	describe('Reset', () => {
		it('should reset all metrics', () => {
			metrics.counter('test', 1);
			metrics.gauge('test', 5);
			metrics.histogram('test', 0.5);

			expect(metrics.get('test')).toBe(5);
			expect(metrics.getOperationCount()).toBe(3);

			metrics.reset();

			expect(metrics.get('test')).toBeUndefined();
			expect(metrics.getOperationCount()).toBe(0);
		});

		it('clears adversarially distinct series and their copied metadata', () => {
			const combinedLabel = { a: '1,b=2' };
			const splitLabels = { a: '1', b: '2' };
			metrics.counter('collision_counter', 2, combinedLabel);
			metrics.gauge('collision_gauge', 3, splitLabels);
			metrics.histogram('collision_histogram', 4, combinedLabel, [5]);

			metrics.reset();
			combinedLabel.a = 'mutated';
			splitLabels.a = 'mutated';

			expect(metrics.get('collision_counter', { a: '1,b=2' })).toBeUndefined();
			expect(metrics.get('collision_gauge', { a: '1', b: '2' })).toBeUndefined();
			expect(metrics.export()).toBe('');
			expect(metrics.getOperationCount()).toBe(0);
		});
	});

	describe('Operation Counting', () => {
		it('should track metric operations', () => {
			metrics.counter('a', 1);
			metrics.counter('b', 1);
			metrics.counter('c', 1);

			expect(metrics.getOperationCount()).toBe(3);
		});

		it('should track histogram operations as 1 each', () => {
			metrics.histogram('a', 0.5);
			metrics.histogram('b', 0.5);

			expect(metrics.getOperationCount()).toBe(2);
		});
	});
});
