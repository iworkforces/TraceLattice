import type { SessionId } from '../../contracts/ids.js';
import type { GraphView } from '../graph/GraphView.js';
import type { GraphSignals } from '../reasoning.js';

export interface ActiveGraphContext {
	readonly sessionId: SessionId;
	readonly view: GraphView;
}

/** Stateless, additive graph analytics; does not affect structural scoring. */
export class GraphSignalComputer {
	public compute(ctx: ActiveGraphContext): GraphSignals | undefined {
		const metrics = ctx.view.metrics(ctx.sessionId);
		if (metrics.edge_count === 0) return undefined;
		return {
			...metrics,
			branching_factor: roundToPrecision(
				metrics.edge_count / (metrics.node_count - metrics.leaf_count)
			),
			relational_density: roundToPrecision(
				(metrics.edge_count - metrics.edge_kind_counts.sequence) / metrics.edge_count
			),
		};
	}
}

function roundToPrecision(value: number): number {
	return Math.round(value * 1e10) / 1e10;
}
