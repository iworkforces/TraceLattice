/**
 * Prometheus-compatible metrics collection.
 *
 * This module provides metrics collection and export in Prometheus text format.
 * Supports counters, gauges, and histograms for observability.
 *
 * @module metrics
 */

/**
 * Metric types supported by the metrics collector.
 */
export enum MetricType {
	/** Counter - a cumulative metric that only increases */
	Counter = 'counter',

	/** Gauge - a metric that can go up and down */
	Gauge = 'gauge',

	/** Histogram - a metric for sampling observations */
	Histogram = 'histogram',
}

/**
 * A collected metric with its value and labels.
 */
export interface Metric {
	/** Name of the metric */
	name: string;

	/** Type of metric (counter, gauge, histogram) */
	type: MetricType;

	/** Current value */
	value: number;

	/** Labels for the metric */
	labels: Record<string, string>;

	/** Help text describing the metric */
	help?: string;

	/** Timestamp when metric was recorded (Unix epoch) */
	timestamp?: number;
}

interface HistogramMetric {
	name: string;
	labels: Record<string, string>;
	sum: number;
	count: number;
	boundaries: readonly number[];
	buckets: Map<number, number>;
}

/**
 * Histogram bucket boundaries for latency tracking.
 */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Prometheus-compatible metrics collector.
 *
 * Collects and exports metrics in Prometheus text format for scraping.
 * Thread-safe and supports counters, gauges, and histograms.
 *
 * @remarks
 * **Metric Types:**
 * - **Counter**: Cumulative value that only increases (e.g., request counts)
 * - **Gauge**: Value that can go up or down (e.g., active connections)
 * - **Histogram**: Sampling observations (e.g., request latency)
 *
 * **Labels:**
 * Metrics can have labels for dimensional data:
 * ```typescript
 * counter('http_requests_total', { method: 'GET', status: '200' });
 * ```
 *
 * **Export Format:**
 * Metrics are exported in Prometheus text format:
 * ```
 * # HELP http_requests_total Total HTTP requests
 * # TYPE http_requests_total counter
 * http_requests_total{method="GET",status="200"} 1234
 * ```
 *
 * @example
 * ```typescript
 * const metrics = new Metrics({ prefix: 'mcp_server' });
 *
 * // Count requests
 * metrics.counter('requests_total', { method: 'GET' }).inc();
 *
 * // Track active connections
 * const activeConnections = metrics.gauge('active_connections');
 * activeConnections.set(5);
 * activeConnections.dec();
 *
 * // Record latency
 * metrics.histogram('request_duration_seconds').observe(0.023);
 *
 * // Export for Prometheus
 * const prometheusText = metrics.export();
 * ```
 */
export class Metrics {
	/** Metrics storage indexed by name and label hash */
	private _metrics: Map<string, Metric>;

	/** Histogram samples */
	private _histograms: Map<string, HistogramMetric>;

	/** Prefix for all metric names */
	private _prefix: string;

	/** Default labels to apply to all metrics */
	private _defaultLabels: Record<string, string>;

	/** Counter for metric collection operations */
	private _operationsCounter: number = 0;

	/**
	 * Creates a new Metrics instance.
	 *
	 * @param options - Configuration options
	 *
	 * @example
	 * ```typescript
	 * const metrics = new Metrics({ prefix: 'mcp_server' });
	 * ```
	 */
	constructor(options: { prefix?: string; defaultLabels?: Record<string, string> } = {}) {
		this._metrics = new Map();
		this._histograms = new Map();
		this._prefix = options.prefix ?? '';
		this._defaultLabels = { ...options.defaultLabels };
	}

	/**
	 * Creates a counter metric.
	 *
	 * @param name - Metric name
	 * @param value - Increment value (default: 1)
	 * @param labels - Optional labels
	 * @param help - Help text
	 *
	 * @example
	 * ```typescript
	 * metrics.counter('requests_total', 1, { method: 'GET' });
	 * metrics.counter('errors_total', 1, { type: 'timeout' });
	 * ```
	 */
	counter(name: string, value = 1, labels: Record<string, string> = {}, help?: string): void {
		const fullName = this._fullName(name);
		const allLabels = { ...this._defaultLabels, ...labels };
		const key = this._metricKey(fullName, allLabels);
		const existing = this._metrics.get(key);

		if (existing) {
			existing.value += value;
			if (help && !existing.help) {
				existing.help = help;
			}
		} else {
			this._metrics.set(key, {
				name: fullName,
				type: MetricType.Counter,
				value,
				labels: { ...allLabels },
				help,
			});
		}
		this._operationsCounter++;
	}

	/**
	 * Creates a gauge metric.
	 *
	 * @param name - Metric name
	 * @param value - Current value
	 * @param labels - Optional labels
	 * @param help - Help text
	 *
	 * @example
	 * ```typescript
	 * const activeConnections = metrics.gauge('active_connections');
	 * activeConnections.set(5);
	 * activeConnections.dec();
	 * ```
	 */
	gauge(name: string, value: number, labels: Record<string, string> = {}, help?: string): void {
		const fullName = this._fullName(name);
		const allLabels = { ...this._defaultLabels, ...labels };
		const key = this._metricKey(fullName, allLabels);
		const existing = this._metrics.get(key);
		this._metrics.set(key, {
			name: fullName,
			type: MetricType.Gauge,
			value,
			labels: { ...allLabels },
			help: help ?? existing?.help,
		});
		this._operationsCounter++;
	}

	/**
	 * Records a histogram observation.
	 *
	 * @param name - Histogram name
	 * @param value - Observed value
	 * @param labels - Optional labels
	 * @param help - Help text
	 * @param buckets - Custom bucket boundaries
	 *
	 * @example
	 * ```typescript
	 * metrics.histogram('request_duration_seconds').observe(0.023);
	 * metrics.histogram('thought_processing_ms').observe(45);
	 * ```
	 */
	histogram(
		name: string,
		value: number,
		labels: Record<string, string> = {},
		buckets = DEFAULT_BUCKETS
	): void {
		const fullName = this._fullName(name);
		const allLabels = { ...this._defaultLabels, ...labels };
		const key = this._metricKey(fullName, allLabels);
		const histogram = this._histograms.get(key);
		let previousBoundary = -Infinity;
		for (const boundary of buckets) {
			if (!Number.isFinite(boundary) || boundary <= previousBoundary) {
				throw new RangeError('Histogram boundaries must be finite and strictly increasing');
			}
			previousBoundary = boundary;
		}
		if (
			histogram &&
			(histogram.boundaries.length !== buckets.length ||
				histogram.boundaries.some((boundary, index) => boundary !== buckets[index]))
		) {
			throw new RangeError('Histogram bucket layout differs from the existing series');
		}

		if (histogram) {
			histogram.sum += value;
			histogram.count += 1;
			for (const boundary of histogram.boundaries) {
				if (value <= boundary) {
					histogram.buckets.set(boundary, (histogram.buckets.get(boundary) ?? 0) + 1);
				}
			}
		} else {
			const histogramData = {
				name: fullName,
				labels: { ...allLabels },
				sum: value,
				count: 1,
				boundaries: [...buckets],
				buckets: new Map<number, number>(),
			};
			for (const boundary of buckets) {
				histogramData.buckets.set(boundary, value <= boundary ? 1 : 0);
			}
			this._histograms.set(key, histogramData);
		}
		this._operationsCounter++;
	}

	/**
	 * Gets the current value of a metric.
	 *
	 * @param name - Metric name
	 * @param labels - Labels
	 * @returns Current value or undefined if not found
	 *
	 * @example
	 * ```typescript
	 * const count = metrics.get('requests_total', { method: 'GET' });
	 * ```
	 */
	get(name: string, labels: Record<string, string> = {}): number | undefined {
		const fullName = this._fullName(name);
		const allLabels = { ...this._defaultLabels, ...labels };
		const key = this._metricKey(fullName, allLabels);
		return this._metrics.get(key)?.value;
	}

	/**
	 * Increments a counter by 1.
	 *
	 * @param name - Metric name
	 * @param labels - Optional labels
	 *
	 * @example
	 * ```typescript
	 * metrics.inc('requests_total', { method: 'GET' });
	 * ```
	 */
	inc(name: string, labels?: Record<string, string>): void {
		this.counter(name, 1, labels);
	}

	/**
	 * Decrements a gauge by 1.
	 *
	 * @param name - Metric name
	 * @param labels - Optional labels
	 *
	 * @example
	 * ```typescript
	 * metrics.dec('active_connections');
	 * ```
	 */
	dec(name: string, labels?: Record<string, string>): void {
		const value = this.get(name, labels) ?? 0;
		this.gauge(name, value - 1, labels);
	}

	/**
	 * Resets all metrics to zero.
	 * Useful for testing or on server restart.
	 *
	 * @example
	 * ```typescript
	 * metrics.reset();
	 * ```
	 */
	reset(): void {
		this._metrics.clear();
		this._histograms.clear();
		this._operationsCounter = 0;
	}

	/**
	 * Gets the number of metric operations performed.
	 * Useful for testing.
	 *
	 * @returns Operation count
	 *
	 * @example
	 * ```typescript
	 * const ops = metrics.getOperationCount();
	 * ```
	 */
	getOperationCount(): number {
		return this._operationsCounter;
	}

	/**
	 * Exports metrics in Prometheus text format.
	 *
	 * @returns Prometheus text format string
	 *
	 * @example
	 * ```typescript
	 * const prometheusText = metrics.export();
	 * console.log(prometheusText);
	 * // Output:
	 * // # HELP http_requests_total Total HTTP requests
	 * // # TYPE http_requests_total counter
	 * // http_requests_total{method="GET",status="200"} 1234
	 * ```
	 */
	export(): string {
		const lines: string[] = [];

		const metrics = Array.from(this._metrics.values());
		const histograms = Array.from(this._histograms.values());

		const helpEntries = new Map<string, string>();
		const typeEntries = new Map<string, MetricType>();

		for (const metric of metrics) {
			if (!helpEntries.has(metric.name)) {
				const helpText = metric.help ?? `${metric.name} metric`;
				lines.push(
					`# HELP ${metric.name} ${helpText.replaceAll('\\', '\\\\').replaceAll('\n', '\\n')}`
				);
				helpEntries.set(metric.name, helpText);
			}
			if (!typeEntries.has(metric.name)) {
				lines.push(`# TYPE ${metric.name} ${metric.type}`);
				typeEntries.set(metric.name, metric.type);
			}

			const labelStr = this._formatLabels(metric.labels);
			lines.push(`${metric.name}{${labelStr}} ${metric.value}`);
		}

		for (const histogram of histograms) {
			const { name: fullName, labels } = histogram;
			if (histogram.count > 0) {
				if (!typeEntries.has(fullName)) {
					lines.push(`# TYPE ${fullName} histogram`);
					typeEntries.set(fullName, MetricType.Histogram);
				}

				const labelStr = this._formatLabels(labels);
				const formatMetricLine = (suffix: string, value: number): string => {
					if (labelStr.length === 0) {
						return `${fullName}${suffix} ${value}`;
					}

					return `${fullName}${suffix}{${labelStr}} ${value}`;
				};

				lines.push(formatMetricLine('_sum', histogram.sum));
				lines.push(formatMetricLine('_count', histogram.count));

				for (const boundary of histogram.boundaries) {
					const count = histogram.buckets.get(boundary);
					const boundaryLabel = String(boundary);
					const boundaryLabelStr = this._formatLabels({ le: boundaryLabel });
					const bucketLabels =
						labelStr.length === 0 ? boundaryLabelStr : `${labelStr},${boundaryLabelStr}`;
					lines.push(`${fullName}_bucket{${bucketLabels}} ${count}`);
				}
				const infLabelStr = this._formatLabels({ le: '+Inf' });
				const infLabels = labelStr.length === 0 ? infLabelStr : `${labelStr},${infLabelStr}`;
				lines.push(`${fullName}_bucket{${infLabels}} ${histogram.count}`);
			}
		}

		return lines.join('\n');
	}

	/**
	 * Gets metric name with prefix.
	 * @param name - Metric name
	 * @returns Full metric name
	 * @private
	 */
	private _fullName(name: string): string {
		if (!this._prefix) {
			return name;
		}

		const prefix = `${this._prefix}_`;
		return name.startsWith(prefix) ? name : `${prefix}${name}`;
	}

	/**
	 * Creates a unique key for a metric with labels.
	 * @param name - Metric name
	 * @param labels - Labels
	 * @returns Unique key
	 * @private
	 */
	private _metricKey(name: string, labels: Record<string, string>): string {
		const sortedLabels = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return JSON.stringify([name, sortedLabels]);
	}

	private _formatLabels(labels: Record<string, string>): string {
		return Object.entries(labels)
			.map(([key, value]) => `${key}="${this._escapeLabelValue(value)}"`)
			.join(',');
	}

	private _escapeLabelValue(value: string): string {
		return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
	}
}
