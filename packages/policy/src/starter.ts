import type { DeploymentPolicy } from "./types.js";

/**
 * A conservative starting policy for deployment review. It requires complete
 * reproducibility evidence, sets one availability floor and one latency
 * ceiling, and bounds TTFT and token-throughput regressions against a
 * baseline Passport while allowing only the artifact revision, runtime
 * version, and endpoint origin to change.
 */
export function starterDeploymentPolicy(): DeploymentPolicy {
  return {
    schemaVersion: "0.1.0",
    kind: "moemodels_deploybench_policy",
    name: "starter-serving-gate",
    description:
      "Fail deployment review when measured serving evidence regresses, breaches static objectives, or arrives incomplete.",
    evidence: {
      requireReproducibilityComplete: true,
    },
    comparison: {
      allowedChanges: ["artifact.revision", "runtime.version", "endpointOrigin"],
    },
    rules: [
      {
        id: "success-rate-floor",
        kind: "absolute",
        metric: "success_rate",
        aggregation: "worst_trial",
        comparator: "gte",
        threshold: 0.99,
      },
      {
        id: "ttft-p95-ceiling",
        kind: "absolute",
        metric: "ttft_p95_ms",
        aggregation: "worst_trial",
        comparator: "lte",
        threshold: 800,
      },
      {
        id: "ttft-p95-regression",
        kind: "relative",
        metric: "ttft_p95_ms",
        aggregation: "median_of_trials",
        direction: "increase_is_regression",
        tolerancePct: 10,
      },
      {
        id: "token-throughput-regression",
        kind: "relative",
        metric: "output_token_throughput_per_second",
        aggregation: "median_of_trials",
        direction: "decrease_is_regression",
        tolerancePct: 5,
      },
    ],
    waivers: [],
  };
}
