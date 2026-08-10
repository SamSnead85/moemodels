import {
  canonicalizeJson,
  endpointBenchmarkConfiguration,
  type EndpointBenchmarkResult,
} from "@moemodels/bench/browser";

import {
  POLICY_IDENTITY_CHANGE_PATHS,
  type PassportComparisonReport,
  type PolicyIdentityChange,
  type PolicyIdentityChangePath,
} from "./types.js";

type TrialConfiguration = ReturnType<typeof endpointBenchmarkConfiguration>;

function identityValue(
  configuration: TrialConfiguration,
  path: PolicyIdentityChangePath,
): string | null {
  switch (path) {
    case "endpointOrigin":
      return configuration.endpointOrigin;
    case "model":
      return configuration.model;
    case "artifact.binding":
      return configuration.artifact.binding;
    case "artifact.repository":
      return configuration.artifact.repository;
    case "artifact.revision":
      return configuration.artifact.revision;
    case "runtime.name":
      return configuration.runtime.name;
    case "runtime.version":
      return configuration.runtime.version;
    case "infrastructure.hardware":
      return configuration.infrastructure.hardware;
    case "infrastructure.topology":
      return configuration.infrastructure.topology;
  }
}

/**
 * Compare a baseline and candidate trial configuration for a regression
 * decision. Workload identity must match exactly — measurements taken under
 * different prompts, request counts, concurrency, or token limits are not
 * comparable. Identity fields may differ only when the policy explicitly lists
 * them; every difference is reported either way, so the receipt names the
 * change surface instead of implying "same deployment".
 */
export function comparePassportConfigurations(
  baselineTrial: EndpointBenchmarkResult,
  candidateTrial: EndpointBenchmarkResult,
  allowedChanges: readonly PolicyIdentityChangePath[],
): PassportComparisonReport {
  const baseline = endpointBenchmarkConfiguration(baselineTrial);
  const candidate = endpointBenchmarkConfiguration(candidateTrial);
  const allowed = new Set(allowedChanges);

  const workloadCompatible =
    canonicalizeJson(baseline.workload) === canonicalizeJson(candidate.workload);

  const identityChanges: PolicyIdentityChange[] = [];
  for (const path of POLICY_IDENTITY_CHANGE_PATHS) {
    const baselineValue = identityValue(baseline, path);
    const candidateValue = identityValue(candidate, path);
    if (baselineValue !== candidateValue) {
      identityChanges.push({
        path,
        baseline: baselineValue,
        candidate: candidateValue,
        allowed: allowed.has(path),
      });
    }
  }
  const unlistedChanges = identityChanges
    .filter((change) => !change.allowed)
    .map((change) => change.path);
  const compatible = workloadCompatible && unlistedChanges.length === 0;

  const detail = !workloadCompatible
    ? "Workload configurations differ; measured distributions are not comparable."
    : unlistedChanges.length > 0
      ? `Identity changed outside the policy's allowed change surface: ${unlistedChanges.join(", ")}.`
      : identityChanges.length > 0
        ? `Comparable under the declared change surface: ${identityChanges
            .map((change) => change.path)
            .join(", ")}.`
        : "Baseline and candidate declare an identical configuration.";

  return { workloadCompatible, identityChanges, unlistedChanges, compatible, detail };
}
