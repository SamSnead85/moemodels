import {
  verifyEvidencePassport,
  type DeployBenchEvidencePassport,
  type EvidencePassportVerification,
} from "@moemodels/bench/browser";

import { comparePassportConfigurations } from "./compare.js";
import { aggregateTrialMetric, formatMetricValue } from "./metrics.js";
import {
  DeploymentPolicyError,
  POLICY_EVALUATION_BOUNDARIES,
  POLICY_EVALUATION_KIND,
  POLICY_EVALUATION_SCHEMA_VERSION,
  type AbsolutePolicyRule,
  type DeploymentPolicy,
  type DeploymentPolicyEvaluation,
  type PassportComparisonReport,
  type PolicyEvidenceCheck,
  type PolicyPassportSummary,
  type PolicyRuleEvaluation,
  type PolicyVerdict,
  type PolicyWaiverReport,
  type RelativePolicyRule,
} from "./types.js";
import {
  activeWaiverFor,
  computePolicyId,
  parseDeploymentPolicy,
  policyRuleConstraint,
} from "./validate.js";

export interface PolicyEvaluationOptions {
  policy: unknown;
  candidate: unknown;
  baseline?: unknown;
  /**
   * Wall-clock instant used only to decide waiver expiry. When absent, no
   * waiver can apply: an unbounded waiver would silence a failing rule
   * forever, so the engine fails closed instead.
   */
  evaluatedAt?: Date | string;
}

interface VerifiedPassport {
  summary: PolicyPassportSummary;
  passport: DeployBenchEvidencePassport | null;
  verification: EvidencePassportVerification | null;
}

const MAX_REPORTED_ISSUES = 12;

async function verifyInput(input: unknown): Promise<VerifiedPassport> {
  const verification = await verifyEvidencePassport(input);
  const passport = verification.valid
    ? (input as DeployBenchEvidencePassport)
    : null;
  return {
    verification,
    passport,
    summary: {
      passportId: passport?.passportId ?? null,
      verified: verification.valid,
      trials: passport?.payload.trials.length ?? 0,
      reproducibilityComplete:
        verification.recomputedReproducibility?.complete ?? false,
      issues: verification.issues.slice(0, MAX_REPORTED_ISSUES),
    },
  };
}

function normalizeEvaluatedAt(input: Date | string | undefined): string | null {
  if (input === undefined) return null;
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) {
    throw new DeploymentPolicyError("evaluatedAt is not a valid instant.");
  }
  return date.toISOString();
}

function evidenceChecks(
  policy: DeploymentPolicy,
  verification: EvidencePassportVerification,
): PolicyEvidenceCheck[] {
  const reproducibility = verification.recomputedReproducibility;
  const checks: PolicyEvidenceCheck[] = [
    {
      id: "reproducibility_complete",
      required: policy.evidence.requireReproducibilityComplete,
      passed: reproducibility?.complete ?? false,
      detail: reproducibility?.complete
        ? "All reproducibility gates pass."
        : `Missing gates: ${reproducibility?.missing.join(", ") || "unknown"}.`,
    },
  ];
  if (policy.evidence.requiredGates) {
    const passed = new Set(
      (reproducibility?.gates ?? [])
        .filter((gate) => gate.passed)
        .map((gate) => gate.id),
    );
    const missing = policy.evidence.requiredGates.filter((gate) => !passed.has(gate));
    checks.push({
      id: "required_gates",
      required: true,
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `Required gates pass: ${policy.evidence.requiredGates.join(", ")}.`
          : `Required gates failing: ${missing.join(", ")}.`,
    });
  }
  if (policy.evidence.minimumTrials !== undefined) {
    const observed = reproducibility?.observedTrials ?? 0;
    checks.push({
      id: "minimum_trials",
      required: true,
      passed: observed >= policy.evidence.minimumTrials,
      detail: `${observed} trial(s) observed; ${policy.evidence.minimumTrials} required.`,
    });
  }
  return checks;
}

function absoluteRuleEvaluation(
  rule: AbsolutePolicyRule,
  candidate: DeployBenchEvidencePassport,
): Omit<PolicyRuleEvaluation, "outcome" | "underlyingOutcome" | "waiver"> & {
  underlying: "pass" | "fail" | "unknown";
} {
  const violationExtreme = rule.comparator === "lte" ? "max" : "min";
  const observed = aggregateTrialMetric(
    candidate.payload.trials,
    rule.metric,
    rule.aggregation,
    violationExtreme,
  );
  const underlying =
    observed === null
      ? "unknown"
      : rule.comparator === "lte"
        ? observed <= rule.threshold
          ? "pass"
          : "fail"
        : observed >= rule.threshold
          ? "pass"
          : "fail";
  return {
    id: rule.id,
    kind: "absolute",
    metric: rule.metric,
    aggregation: rule.aggregation,
    constraint: policyRuleConstraint(rule),
    observed,
    baselineObserved: null,
    limit: rule.threshold,
    detail:
      observed === null
        ? "The candidate trials do not report this metric; unknown never passes."
        : `Observed ${formatMetricValue(observed, rule.metric)} against limit ${formatMetricValue(rule.threshold, rule.metric)} (${rule.aggregation}).`,
    underlying,
  };
}

function relativeRuleEvaluation(
  rule: RelativePolicyRule,
  candidate: DeployBenchEvidencePassport,
  baseline: DeployBenchEvidencePassport | null,
  comparison: PassportComparisonReport | null,
): Omit<PolicyRuleEvaluation, "outcome" | "underlyingOutcome" | "waiver"> & {
  underlying: "pass" | "fail" | "unknown";
} {
  const increase = rule.direction === "increase_is_regression";
  const violationExtreme = increase ? "max" : "min";
  const base = {
    id: rule.id,
    kind: "relative" as const,
    metric: rule.metric,
    aggregation: rule.aggregation,
    constraint: policyRuleConstraint(rule),
  };
  if (!baseline) {
    return {
      ...base,
      observed: null,
      baselineObserved: null,
      limit: null,
      detail: "A verified baseline Passport is required for this relative rule.",
      underlying: "unknown",
    };
  }
  if (!comparison?.compatible) {
    return {
      ...base,
      observed: null,
      baselineObserved: null,
      limit: null,
      detail: `Baseline and candidate are not comparable: ${comparison?.detail ?? "no comparison available."}`,
      underlying: "unknown",
    };
  }
  const observed = aggregateTrialMetric(
    candidate.payload.trials,
    rule.metric,
    rule.aggregation,
    violationExtreme,
  );
  const baselineObserved = aggregateTrialMetric(
    baseline.payload.trials,
    rule.metric,
    rule.aggregation,
    violationExtreme,
  );
  if (observed === null || baselineObserved === null) {
    return {
      ...base,
      observed,
      baselineObserved,
      limit: null,
      detail: "Baseline or candidate trials do not report this metric; unknown never passes.",
      underlying: "unknown",
    };
  }
  const limit = increase
    ? baselineObserved * (1 + rule.tolerancePct / 100)
    : baselineObserved * (1 - rule.tolerancePct / 100);
  const underlying = increase
    ? observed <= limit
      ? "pass"
      : "fail"
    : observed >= limit
      ? "pass"
      : "fail";
  return {
    ...base,
    observed,
    baselineObserved,
    limit,
    detail: `Candidate ${formatMetricValue(observed, rule.metric)} vs baseline ${formatMetricValue(baselineObserved, rule.metric)}; limit ${formatMetricValue(limit, rule.metric)} (${rule.aggregation}).`,
    underlying,
  };
}

/**
 * Evaluate a deployment policy against a verified candidate Passport and an
 * optional verified baseline Passport. The verdict is deliberately
 * three-valued: "pass" and "fail" require complete evidence for every rule,
 * while missing metrics, a missing or unverifiable baseline, or an
 * incomparable configuration produce "inconclusive" instead of a fabricated
 * answer.
 */
export async function evaluateDeploymentPolicy(
  options: PolicyEvaluationOptions,
): Promise<DeploymentPolicyEvaluation> {
  const policy = parseDeploymentPolicy(options.policy);
  const policyId = await computePolicyId(policy);
  const evaluatedAt = normalizeEvaluatedAt(options.evaluatedAt);
  const evaluatedAtMs = evaluatedAt === null ? null : Date.parse(evaluatedAt);

  const candidate = await verifyInput(options.candidate);
  const baseline =
    options.baseline === undefined ? null : await verifyInput(options.baseline);

  const reasons: string[] = [];
  const rules: PolicyRuleEvaluation[] = [];
  let checks: PolicyEvidenceCheck[] = [];
  let comparison: PassportComparisonReport | null = null;

  if (!candidate.summary.verified) {
    reasons.push("The candidate Passport failed verification; no rule was evaluated.");
  } else if (candidate.passport && candidate.verification) {
    checks = evidenceChecks(policy, candidate.verification);
    for (const check of checks) {
      if (check.required && !check.passed) {
        reasons.push(`Evidence requirement failed: ${check.id} — ${check.detail}`);
      }
    }

    if (baseline && !baseline.summary.verified) {
      reasons.push(
        "The baseline Passport failed verification; relative rules are inconclusive.",
      );
    }
    const baselinePassport = baseline?.passport ?? null;
    const baselineTrial = baselinePassport?.payload.trials[0];
    const candidateTrial = candidate.passport.payload.trials[0];
    if (baselineTrial && candidateTrial) {
      comparison = comparePassportConfigurations(
        baselineTrial,
        candidateTrial,
        policy.comparison?.allowedChanges ?? [],
      );
    }

    for (const rule of policy.rules) {
      const evaluated =
        rule.kind === "absolute"
          ? absoluteRuleEvaluation(rule, candidate.passport)
          : relativeRuleEvaluation(rule, candidate.passport, baselinePassport, comparison);
      const { underlying, ...rest } = evaluated;
      const waiver =
        underlying === "pass"
          ? null
          : activeWaiverFor(policy, rule.id, evaluatedAtMs);
      rules.push({
        ...rest,
        outcome: waiver ? "waived" : underlying,
        underlyingOutcome: waiver ? underlying : null,
        waiver,
        detail: waiver
          ? `${rest.detail} Waived by ${waiver.approvedBy} until ${waiver.expiresAt}: ${waiver.reason}`
          : rest.detail,
      });
    }
  }

  const waiverReports: PolicyWaiverReport[] = policy.waivers.map((waiver) => {
    const applied = rules.some(
      (rule) => rule.outcome === "waived" && rule.waiver?.ruleId === waiver.ruleId,
    );
    const expired =
      evaluatedAtMs !== null && evaluatedAtMs >= Date.parse(waiver.expiresAt);
    return {
      ruleId: waiver.ruleId,
      status: applied ? "applied" : expired ? "expired" : "unused",
      expiresAt: waiver.expiresAt,
      detail: applied
        ? `Applied to a ${rules.find((rule) => rule.waiver?.ruleId === waiver.ruleId)?.underlyingOutcome ?? "failing"} rule outcome.`
        : expired
          ? "Expired; the underlying rule outcome stands."
          : evaluatedAtMs === null
            ? "Not applied: waiver expiry cannot be checked without an evaluation instant."
            : "Not needed at this evaluation.",
    };
  });

  const failedRules = rules.filter((rule) => rule.outcome === "fail");
  const unknownRules = rules.filter((rule) => rule.outcome === "unknown");
  for (const rule of failedRules) {
    reasons.push(`Rule failed: ${rule.id} — ${rule.detail}`);
  }
  for (const rule of unknownRules) {
    reasons.push(`Rule inconclusive: ${rule.id} — ${rule.detail}`);
  }

  const evidenceFailed = checks.some((check) => check.required && !check.passed);
  const verdict: PolicyVerdict =
    !candidate.summary.verified || evidenceFailed || failedRules.length > 0
      ? "fail"
      : unknownRules.length > 0
        ? "inconclusive"
        : "pass";

  return {
    schemaVersion: POLICY_EVALUATION_SCHEMA_VERSION,
    kind: POLICY_EVALUATION_KIND,
    policyId,
    policyName: policy.name,
    evaluatedAt,
    candidate: candidate.summary,
    baseline: baseline?.summary ?? null,
    comparison,
    evidenceChecks: checks,
    rules,
    waivers: waiverReports,
    verdict,
    reasons,
    boundaries: [...POLICY_EVALUATION_BOUNDARIES],
  };
}
