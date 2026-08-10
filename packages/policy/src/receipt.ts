import { formatMetricValue } from "./metrics.js";
import type { DeploymentPolicyEvaluation } from "./types.js";

const VERDICT_BADGE = {
  pass: "✅ PASS",
  fail: "❌ FAIL",
  inconclusive: "⚠️ INCONCLUSIVE",
} as const;

const OUTCOME_MARK = {
  pass: "✅",
  fail: "❌",
  unknown: "⚠️",
  waived: "⏸️",
} as const;

function compactId(value: string | null): string {
  if (!value) return "unverified";
  return value.length <= 40 ? value : `${value.slice(0, 29)}…${value.slice(-8)}`;
}

/**
 * GitHub-ready Markdown receipt for one policy evaluation. The receipt states
 * the verdict, every rule outcome, the declared change surface, and the
 * evidence boundaries, so a green check cannot silently overstate its meaning.
 */
export function policyReceiptMarkdown(
  evaluation: DeploymentPolicyEvaluation,
): string {
  const lines: string[] = [];
  lines.push(`# Deployment policy verdict: ${VERDICT_BADGE[evaluation.verdict]}`);
  lines.push("");
  lines.push(`- Policy: **${evaluation.policyName}** (\`${compactId(evaluation.policyId)}\`)`);
  lines.push(`- Candidate: \`${compactId(evaluation.candidate.passportId)}\` — ${evaluation.candidate.verified ? "verified" : "FAILED VERIFICATION"}, ${evaluation.candidate.trials} trial(s)`);
  if (evaluation.baseline) {
    lines.push(`- Baseline: \`${compactId(evaluation.baseline.passportId)}\` — ${evaluation.baseline.verified ? "verified" : "FAILED VERIFICATION"}, ${evaluation.baseline.trials} trial(s)`);
  }
  if (evaluation.evaluatedAt) {
    lines.push(`- Evaluated at: ${evaluation.evaluatedAt}`);
  }
  lines.push("");

  if (evaluation.evidenceChecks.length > 0) {
    lines.push("## Evidence requirements");
    lines.push("");
    for (const check of evaluation.evidenceChecks) {
      const mark = check.passed ? "✅" : check.required ? "❌" : "⚠️";
      lines.push(`- ${mark} **${check.id.replaceAll("_", " ")}** — ${check.detail}`);
    }
    lines.push("");
  }

  if (evaluation.comparison) {
    lines.push("## Baseline comparison");
    lines.push("");
    lines.push(`- ${evaluation.comparison.compatible ? "✅" : "❌"} ${evaluation.comparison.detail}`);
    for (const change of evaluation.comparison.identityChanges) {
      lines.push(
        `- ${change.allowed ? "🔀" : "🚫"} \`${change.path}\`: \`${change.baseline ?? "unknown"}\` → \`${change.candidate ?? "unknown"}\`${change.allowed ? "" : " (not in the allowed change surface)"}`,
      );
    }
    lines.push("");
  }

  if (evaluation.rules.length > 0) {
    lines.push("## Rules");
    lines.push("");
    lines.push("| Outcome | Rule | Constraint | Observed | Baseline | Limit |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const rule of evaluation.rules) {
      lines.push(
        `| ${OUTCOME_MARK[rule.outcome]} ${rule.outcome} | \`${rule.id}\` | ${rule.constraint} | ${formatMetricValue(rule.observed, rule.metric)} | ${rule.baselineObserved === null ? "—" : formatMetricValue(rule.baselineObserved, rule.metric)} | ${rule.limit === null ? "—" : formatMetricValue(rule.limit, rule.metric)} |`,
      );
    }
    lines.push("");
  }

  const appliedWaivers = evaluation.waivers.filter((waiver) => waiver.status !== "unused");
  if (appliedWaivers.length > 0) {
    lines.push("## Waivers");
    lines.push("");
    for (const waiver of appliedWaivers) {
      lines.push(`- **${waiver.ruleId}** (${waiver.status}, expires ${waiver.expiresAt}) — ${waiver.detail}`);
    }
    lines.push("");
  }

  if (evaluation.reasons.length > 0) {
    lines.push("## Reasons");
    lines.push("");
    for (const reason of evaluation.reasons) {
      lines.push(`- ${reason}`);
    }
    lines.push("");
  }

  lines.push("> " + evaluation.boundaries.join(" "));
  lines.push("");
  return lines.join("\n");
}
