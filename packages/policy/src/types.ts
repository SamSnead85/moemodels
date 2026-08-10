import type { ReproducibilityGateId } from "@moemodels/bench/browser";

export const DEPLOYMENT_POLICY_SCHEMA_VERSION = "0.1.0" as const;
export const DEPLOYMENT_POLICY_KIND = "moemodels_deploybench_policy" as const;
export const POLICY_EVALUATION_SCHEMA_VERSION = "0.1.0" as const;
export const POLICY_EVALUATION_KIND =
  "moemodels_deploybench_policy_evaluation" as const;

export const POLICY_EVALUATION_BOUNDARIES = [
  "A pass verdict applies only to the exact candidate configuration and the checks this policy declares.",
  "Policy evaluation does not verify that the endpoint served the declared model, runtime, hardware, or topology.",
  "A pass verdict is not MOEModels admission, comparison eligibility, or deployment certification.",
  "Unknown metric values are never treated as passing evidence.",
] as const;

/**
 * Deterministic per-trial metrics derived from a verified Passport's stored
 * summaries. Verification has already recomputed every summary from the raw
 * request measurements before a metric is read.
 */
export const POLICY_METRIC_IDS = [
  "success_rate",
  "ttft_p50_ms",
  "ttft_p95_ms",
  "ttft_p99_ms",
  "ttft_mean_ms",
  "ttft_max_ms",
  "latency_p50_ms",
  "latency_p95_ms",
  "latency_p99_ms",
  "latency_mean_ms",
  "latency_max_ms",
  "request_throughput_per_second",
  "output_token_throughput_per_second",
] as const;

export type PolicyMetricId = (typeof POLICY_METRIC_IDS)[number];

export const POLICY_AGGREGATION_IDS = [
  "worst_trial",
  "mean_of_trials",
  "median_of_trials",
] as const;

export type PolicyAggregationId = (typeof POLICY_AGGREGATION_IDS)[number];

/**
 * Identity fields that may legitimately differ between a baseline and a
 * candidate Passport. Workload fields are never listed here: trials measured
 * under different workloads are not comparable under this policy engine.
 */
export const POLICY_IDENTITY_CHANGE_PATHS = [
  "endpointOrigin",
  "model",
  "artifact.binding",
  "artifact.repository",
  "artifact.revision",
  "runtime.name",
  "runtime.version",
  "infrastructure.hardware",
  "infrastructure.topology",
] as const;

export type PolicyIdentityChangePath =
  (typeof POLICY_IDENTITY_CHANGE_PATHS)[number];

export interface AbsolutePolicyRule {
  id: string;
  kind: "absolute";
  metric: PolicyMetricId;
  aggregation: PolicyAggregationId;
  comparator: "lte" | "gte";
  threshold: number;
}

export interface RelativePolicyRule {
  id: string;
  kind: "relative";
  metric: PolicyMetricId;
  aggregation: PolicyAggregationId;
  direction: "increase_is_regression" | "decrease_is_regression";
  tolerancePct: number;
}

export type DeploymentPolicyRule = AbsolutePolicyRule | RelativePolicyRule;

export interface PolicyWaiver {
  ruleId: string;
  reason: string;
  approvedBy: string;
  expiresAt: string;
}

export interface DeploymentPolicyEvidenceRequirements {
  requireReproducibilityComplete: boolean;
  requiredGates?: ReproducibilityGateId[];
  minimumTrials?: number;
}

export interface DeploymentPolicyComparison {
  allowedChanges: PolicyIdentityChangePath[];
}

export interface DeploymentPolicy {
  schemaVersion: typeof DEPLOYMENT_POLICY_SCHEMA_VERSION;
  kind: typeof DEPLOYMENT_POLICY_KIND;
  name: string;
  description: string;
  evidence: DeploymentPolicyEvidenceRequirements;
  comparison?: DeploymentPolicyComparison;
  rules: DeploymentPolicyRule[];
  waivers: PolicyWaiver[];
}

export interface PolicyIdentityChange {
  path: PolicyIdentityChangePath;
  baseline: string | null;
  candidate: string | null;
  allowed: boolean;
}

export interface PassportComparisonReport {
  workloadCompatible: boolean;
  identityChanges: PolicyIdentityChange[];
  unlistedChanges: PolicyIdentityChangePath[];
  compatible: boolean;
  detail: string;
}

export type PolicyRuleOutcome = "pass" | "fail" | "unknown" | "waived";

export interface PolicyRuleEvaluation {
  id: string;
  kind: "absolute" | "relative";
  metric: PolicyMetricId;
  aggregation: PolicyAggregationId;
  constraint: string;
  observed: number | null;
  baselineObserved: number | null;
  limit: number | null;
  outcome: PolicyRuleOutcome;
  underlyingOutcome: Exclude<PolicyRuleOutcome, "waived"> | null;
  waiver: PolicyWaiver | null;
  detail: string;
}

export interface PolicyEvidenceCheck {
  id: "reproducibility_complete" | "required_gates" | "minimum_trials";
  required: boolean;
  passed: boolean;
  detail: string;
}

export type PolicyWaiverStatus = "applied" | "expired" | "unused";

export interface PolicyWaiverReport {
  ruleId: string;
  status: PolicyWaiverStatus;
  expiresAt: string;
  detail: string;
}

export interface PolicyPassportSummary {
  passportId: string | null;
  verified: boolean;
  trials: number;
  reproducibilityComplete: boolean;
  issues: string[];
}

export type PolicyVerdict = "pass" | "fail" | "inconclusive";

export interface DeploymentPolicyEvaluation {
  schemaVersion: typeof POLICY_EVALUATION_SCHEMA_VERSION;
  kind: typeof POLICY_EVALUATION_KIND;
  policyId: string;
  policyName: string;
  evaluatedAt: string | null;
  candidate: PolicyPassportSummary;
  baseline: PolicyPassportSummary | null;
  comparison: PassportComparisonReport | null;
  evidenceChecks: PolicyEvidenceCheck[];
  rules: PolicyRuleEvaluation[];
  waivers: PolicyWaiverReport[];
  verdict: PolicyVerdict;
  reasons: string[];
  boundaries: string[];
}

export class DeploymentPolicyError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "DeploymentPolicyError";
    this.issues = issues;
  }
}
