import type {
  DistributionSummary,
  EndpointBenchmarkResult,
  RequestMeasurement,
} from "./types.js";

export function roundMeasurement(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function summarizeDistribution(
  values: readonly number[],
): DistributionSummary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (probability: number) => {
    const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
    return sorted[index] as number;
  };
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    minimum: roundMeasurement(sorted[0] as number),
    p50: roundMeasurement(percentile(0.5)),
    p95: roundMeasurement(percentile(0.95)),
    p99: roundMeasurement(percentile(0.99)),
    maximum: roundMeasurement(sorted.at(-1) as number),
    mean: roundMeasurement(total / sorted.length),
  };
}

export function summarizeRequestMeasurements(
  measurements: readonly RequestMeasurement[],
  wallTimeMs: number,
): EndpointBenchmarkResult["summary"] {
  const successful = measurements.filter(
    (measurement) => measurement.status === "succeeded",
  );
  const ttftValues = successful.flatMap((measurement) =>
    measurement.ttftMs === null ? [] : [measurement.ttftMs],
  );
  const latencyValues = successful.map(
    (measurement) => measurement.totalLatencyMs,
  );
  const outputTokenValues = successful.map(
    (measurement) => measurement.outputTokens,
  );
  const completeTokenUsage = outputTokenValues.every(
    (value): value is number => value !== null,
  );
  const outputTokens = completeTokenUsage
    ? outputTokenValues.reduce((sum, value) => sum + value, 0)
    : null;
  const safeWallTime = Math.max(0.001, wallTimeMs);

  return {
    attemptedRequests: measurements.length,
    successfulRequests: successful.length,
    failedRequests: measurements.length - successful.length,
    wallTimeMs: roundMeasurement(safeWallTime),
    requestThroughputPerSecond: roundMeasurement(
      successful.length / (safeWallTime / 1000),
    ),
    outputTokenThroughputPerSecond:
      outputTokens === null
        ? null
        : roundMeasurement(outputTokens / (safeWallTime / 1000)),
    ttftMs: summarizeDistribution(ttftValues),
    totalLatencyMs: summarizeDistribution(latencyValues),
  };
}
