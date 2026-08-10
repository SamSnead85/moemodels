import type { EndpointBenchmarkResult } from "@moemodels/bench/browser";

import type { PolicyAggregationId, PolicyMetricId } from "./types.js";

export interface PolicyMetricDescriptor {
  id: PolicyMetricId;
  label: string;
  unit: "ratio" | "ms" | "per_second";
}

export const POLICY_METRICS: readonly PolicyMetricDescriptor[] = [
  { id: "success_rate", label: "Request success rate", unit: "ratio" },
  { id: "ttft_p50_ms", label: "TTFT p50", unit: "ms" },
  { id: "ttft_p95_ms", label: "TTFT p95", unit: "ms" },
  { id: "ttft_p99_ms", label: "TTFT p99", unit: "ms" },
  { id: "ttft_mean_ms", label: "TTFT mean", unit: "ms" },
  { id: "ttft_max_ms", label: "TTFT maximum", unit: "ms" },
  { id: "latency_p50_ms", label: "Total latency p50", unit: "ms" },
  { id: "latency_p95_ms", label: "Total latency p95", unit: "ms" },
  { id: "latency_p99_ms", label: "Total latency p99", unit: "ms" },
  { id: "latency_mean_ms", label: "Total latency mean", unit: "ms" },
  { id: "latency_max_ms", label: "Total latency maximum", unit: "ms" },
  {
    id: "request_throughput_per_second",
    label: "Request throughput",
    unit: "per_second",
  },
  {
    id: "output_token_throughput_per_second",
    label: "Output token throughput",
    unit: "per_second",
  },
];

/**
 * Read one deterministic metric value from a single trial's stored summary.
 * Callers must only pass trials from a Passport whose summaries were already
 * recomputed and verified. A metric an endpoint did not report (for example
 * token throughput without returned usage) is null, never an estimate.
 */
export function extractTrialMetric(
  trial: EndpointBenchmarkResult,
  metric: PolicyMetricId,
): number | null {
  const summary = trial.summary;
  switch (metric) {
    case "success_rate":
      return summary.attemptedRequests === 0
        ? null
        : summary.successfulRequests / summary.attemptedRequests;
    case "ttft_p50_ms":
      return summary.ttftMs?.p50 ?? null;
    case "ttft_p95_ms":
      return summary.ttftMs?.p95 ?? null;
    case "ttft_p99_ms":
      return summary.ttftMs?.p99 ?? null;
    case "ttft_mean_ms":
      return summary.ttftMs?.mean ?? null;
    case "ttft_max_ms":
      return summary.ttftMs?.maximum ?? null;
    case "latency_p50_ms":
      return summary.totalLatencyMs?.p50 ?? null;
    case "latency_p95_ms":
      return summary.totalLatencyMs?.p95 ?? null;
    case "latency_p99_ms":
      return summary.totalLatencyMs?.p99 ?? null;
    case "latency_mean_ms":
      return summary.totalLatencyMs?.mean ?? null;
    case "latency_max_ms":
      return summary.totalLatencyMs?.maximum ?? null;
    case "request_throughput_per_second":
      return summary.requestThroughputPerSecond;
    case "output_token_throughput_per_second":
      return summary.outputTokenThroughputPerSecond;
  }
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * Aggregate one metric across every trial in a Passport. If any trial cannot
 * report the metric the aggregate is unknown — partial evidence is never
 * silently averaged into a precise value. `violationExtreme` selects which
 * extreme "worst_trial" means for the rule being evaluated: "max" when larger
 * values violate the rule, "min" when smaller values do.
 */
export function aggregateTrialMetric(
  trials: readonly EndpointBenchmarkResult[],
  metric: PolicyMetricId,
  aggregation: PolicyAggregationId,
  violationExtreme: "max" | "min",
): number | null {
  if (trials.length === 0) return null;
  const values: number[] = [];
  for (const trial of trials) {
    const value = extractTrialMetric(trial, metric);
    if (value === null) return null;
    values.push(value);
  }
  if (aggregation === "worst_trial") {
    return violationExtreme === "max" ? Math.max(...values) : Math.min(...values);
  }
  if (aggregation === "mean_of_trials") {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  return median([...values].sort((left, right) => left - right));
}

export function formatMetricValue(
  value: number | null,
  metric: PolicyMetricId,
): string {
  if (value === null) return "unknown";
  const descriptor = POLICY_METRICS.find((entry) => entry.id === metric);
  if (descriptor?.unit === "ratio") return `${(value * 100).toFixed(2)}%`;
  if (descriptor?.unit === "ms") return `${value.toFixed(1)} ms`;
  return `${value.toFixed(2)}/s`;
}
