import { canonicalSha256Hex } from "@moemodels/bench/browser";

import {
  DEPLOYMENT_POLICY_KIND,
  DEPLOYMENT_POLICY_SCHEMA_VERSION,
  DeploymentPolicyError,
  POLICY_AGGREGATION_IDS,
  POLICY_IDENTITY_CHANGE_PATHS,
  POLICY_METRIC_IDS,
  type DeploymentPolicy,
  type DeploymentPolicyRule,
  type PolicyWaiver,
} from "./types.js";

const REPRODUCIBILITY_GATE_IDS = new Set([
  "compatible_trials",
  "minimum_trials",
  "immutable_artifact_revision",
  "runtime_identity",
  "infrastructure_identity",
  "request_measurements",
  "privacy_boundary",
]);
const METRIC_ID_SET = new Set<string>(POLICY_METRIC_IDS);
const AGGREGATION_ID_SET = new Set<string>(POLICY_AGGREGATION_IDS);
const IDENTITY_PATH_SET = new Set<string>(POLICY_IDENTITY_CHANGE_PATHS);
const RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

type JsonObject = Record<string, unknown>;

export interface PolicyValidationResult {
  valid: boolean;
  issues: string[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key}: unexpected field`);
  }
  for (const key of required) {
    if (!(key in value)) issues.push(`${path}.${key}: required field is missing`);
  }
}

function stringAt(value: unknown, path: string, issues: string[]): string {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${path}: expected a non-empty string`);
    return "";
  }
  return value;
}

function finiteNumberAt(value: unknown, path: string, issues: string[]): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${path}: expected a finite number`);
    return Number.NaN;
  }
  return value;
}

function validateRule(value: unknown, path: string, issues: string[]): void {
  if (!isObject(value)) {
    issues.push(`${path}: expected a rule object`);
    return;
  }
  const kind = value.kind;
  if (kind !== "absolute" && kind !== "relative") {
    issues.push(`${path}.kind: expected "absolute" or "relative"`);
    return;
  }
  if (kind === "absolute") {
    exactKeys(
      value,
      ["id", "kind", "metric", "aggregation", "comparator", "threshold"],
      [],
      path,
      issues,
    );
    if (value.comparator !== "lte" && value.comparator !== "gte") {
      issues.push(`${path}.comparator: expected "lte" or "gte"`);
    }
    finiteNumberAt(value.threshold, `${path}.threshold`, issues);
  } else {
    exactKeys(
      value,
      ["id", "kind", "metric", "aggregation", "direction", "tolerancePct"],
      [],
      path,
      issues,
    );
    if (
      value.direction !== "increase_is_regression" &&
      value.direction !== "decrease_is_regression"
    ) {
      issues.push(
        `${path}.direction: expected "increase_is_regression" or "decrease_is_regression"`,
      );
    }
    const tolerance = finiteNumberAt(value.tolerancePct, `${path}.tolerancePct`, issues);
    if (Number.isFinite(tolerance) && tolerance < 0) {
      issues.push(`${path}.tolerancePct: expected a non-negative percentage`);
    }
  }
  const id = stringAt(value.id, `${path}.id`, issues);
  if (id && !RULE_ID.test(id)) {
    issues.push(`${path}.id: expected lowercase kebab-case`);
  }
  if (typeof value.metric !== "string" || !METRIC_ID_SET.has(value.metric)) {
    issues.push(`${path}.metric: unknown metric id`);
  }
  if (
    typeof value.aggregation !== "string" ||
    !AGGREGATION_ID_SET.has(value.aggregation)
  ) {
    issues.push(`${path}.aggregation: unknown aggregation id`);
  }
}

function validateWaiver(
  value: unknown,
  path: string,
  ruleIds: ReadonlySet<string>,
  issues: string[],
): void {
  if (!isObject(value)) {
    issues.push(`${path}: expected a waiver object`);
    return;
  }
  exactKeys(value, ["ruleId", "reason", "approvedBy", "expiresAt"], [], path, issues);
  const ruleId = stringAt(value.ruleId, `${path}.ruleId`, issues);
  if (ruleId && !ruleIds.has(ruleId)) {
    issues.push(`${path}.ruleId: does not match a declared rule`);
  }
  stringAt(value.reason, `${path}.reason`, issues);
  stringAt(value.approvedBy, `${path}.approvedBy`, issues);
  const expiresAt = stringAt(value.expiresAt, `${path}.expiresAt`, issues);
  if (
    expiresAt &&
    (!ISO_DATE_TIME.test(expiresAt) || Number.isNaN(Date.parse(expiresAt)))
  ) {
    issues.push(`${path}.expiresAt: expected an ISO 8601 date-time`);
  }
}

/**
 * Strict structural validation for a deployment policy document. Unknown
 * fields, unknown metric or gate ids, duplicate rule ids, dangling waivers,
 * and unparseable expiries are rejected rather than ignored.
 */
export function validateDeploymentPolicy(input: unknown): PolicyValidationResult {
  const issues: string[] = [];
  if (!isObject(input)) {
    return { valid: false, issues: ["$: expected a policy object"] };
  }
  exactKeys(
    input,
    ["schemaVersion", "kind", "name", "description", "evidence", "rules", "waivers"],
    ["comparison"],
    "$",
    issues,
  );
  if (input.schemaVersion !== DEPLOYMENT_POLICY_SCHEMA_VERSION) {
    issues.push(`$.schemaVersion: expected "${DEPLOYMENT_POLICY_SCHEMA_VERSION}"`);
  }
  if (input.kind !== DEPLOYMENT_POLICY_KIND) {
    issues.push(`$.kind: expected "${DEPLOYMENT_POLICY_KIND}"`);
  }
  stringAt(input.name, "$.name", issues);
  stringAt(input.description, "$.description", issues);

  if (!isObject(input.evidence)) {
    issues.push("$.evidence: expected an object");
  } else {
    exactKeys(
      input.evidence,
      ["requireReproducibilityComplete"],
      ["requiredGates", "minimumTrials"],
      "$.evidence",
      issues,
    );
    if (typeof input.evidence.requireReproducibilityComplete !== "boolean") {
      issues.push("$.evidence.requireReproducibilityComplete: expected a boolean");
    }
    if ("requiredGates" in input.evidence) {
      const gates = input.evidence.requiredGates;
      if (!Array.isArray(gates) || gates.length === 0) {
        issues.push("$.evidence.requiredGates: expected a non-empty array");
      } else {
        gates.forEach((gate, index) => {
          if (typeof gate !== "string" || !REPRODUCIBILITY_GATE_IDS.has(gate)) {
            issues.push(`$.evidence.requiredGates[${index}]: unknown reproducibility gate id`);
          }
        });
        if (new Set(gates).size !== gates.length) {
          issues.push("$.evidence.requiredGates: duplicate gate id");
        }
      }
    }
    if ("minimumTrials" in input.evidence) {
      const minimum = input.evidence.minimumTrials;
      if (typeof minimum !== "number" || !Number.isSafeInteger(minimum) || minimum < 1) {
        issues.push("$.evidence.minimumTrials: expected a positive integer");
      }
    }
  }

  if ("comparison" in input) {
    if (!isObject(input.comparison)) {
      issues.push("$.comparison: expected an object");
    } else {
      exactKeys(input.comparison, ["allowedChanges"], [], "$.comparison", issues);
      const allowed = input.comparison.allowedChanges;
      if (!Array.isArray(allowed)) {
        issues.push("$.comparison.allowedChanges: expected an array");
      } else {
        allowed.forEach((path, index) => {
          if (typeof path !== "string" || !IDENTITY_PATH_SET.has(path)) {
            issues.push(`$.comparison.allowedChanges[${index}]: unknown identity path`);
          }
        });
        if (new Set(allowed).size !== allowed.length) {
          issues.push("$.comparison.allowedChanges: duplicate identity path");
        }
      }
    }
  }

  const ruleIds = new Set<string>();
  if (!Array.isArray(input.rules) || input.rules.length === 0) {
    issues.push("$.rules: expected a non-empty array of rules");
  } else {
    input.rules.forEach((rule, index) => {
      validateRule(rule, `$.rules[${index}]`, issues);
      if (isObject(rule) && typeof rule.id === "string" && rule.id.length > 0) {
        if (ruleIds.has(rule.id)) {
          issues.push(`$.rules[${index}].id: duplicate rule id "${rule.id}"`);
        }
        ruleIds.add(rule.id);
      }
    });
  }

  if (!Array.isArray(input.waivers)) {
    issues.push("$.waivers: expected an array");
  } else {
    const waived = new Set<string>();
    input.waivers.forEach((waiver, index) => {
      validateWaiver(waiver, `$.waivers[${index}]`, ruleIds, issues);
      if (isObject(waiver) && typeof waiver.ruleId === "string") {
        if (waived.has(waiver.ruleId)) {
          issues.push(`$.waivers[${index}].ruleId: duplicate waiver for "${waiver.ruleId}"`);
        }
        waived.add(waiver.ruleId);
      }
    });
  }

  return { valid: issues.length === 0, issues: [...new Set(issues)].sort() };
}

export function parseDeploymentPolicy(input: unknown): DeploymentPolicy {
  const result = validateDeploymentPolicy(input);
  if (!result.valid) {
    throw new DeploymentPolicyError(
      "Deployment policy validation failed.",
      result.issues,
    );
  }
  return input as DeploymentPolicy;
}

/** Content address for an exact policy document. */
export async function computePolicyId(policy: DeploymentPolicy): Promise<string> {
  return `deploybench-policy-sha256-${await canonicalSha256Hex(policy)}`;
}

export function policyRuleConstraint(rule: DeploymentPolicyRule): string {
  if (rule.kind === "absolute") {
    return `${rule.metric} ${rule.comparator === "lte" ? "≤" : "≥"} ${rule.threshold}`;
  }
  const sign = rule.direction === "increase_is_regression" ? "+" : "−";
  return `${rule.metric} within ${sign}${rule.tolerancePct}% of baseline`;
}

export function activeWaiverFor(
  policy: DeploymentPolicy,
  ruleId: string,
  evaluatedAtMs: number | null,
): PolicyWaiver | null {
  const waiver = policy.waivers.find((entry) => entry.ruleId === ruleId);
  if (!waiver || evaluatedAtMs === null) return null;
  return evaluatedAtMs < Date.parse(waiver.expiresAt) ? waiver : null;
}
