# @moemodels/policy

Policy-as-code regression gate over verified DeployBench Evidence Passports.

The package turns two artifacts a team already has — a candidate Evidence
Passport and, optionally, a baseline Passport — into one explicit deployment
review decision: **pass**, **fail**, or **inconclusive**. Every rule outcome,
identity change, waiver, and boundary stays attached to the verdict, so a green
check cannot silently overstate what it proves.

## What it enforces

- **Verified evidence only.** Both Passports are cryptographically re-verified
  (payload digest, recomputed summaries, compatible trials) before any metric
  is read. A tampered or malformed Passport fails immediately.
- **Absolute rules.** Threshold checks over deterministic per-trial metrics —
  success rate, TTFT/latency percentiles, request and token throughput — with
  `worst_trial`, `mean_of_trials`, or `median_of_trials` aggregation.
- **Relative rules.** Baseline-versus-candidate regression bounds with an
  explicit tolerance percentage and direction.
- **Declared change surface.** Baseline and candidate must share an identical
  workload; identity fields (artifact revision, runtime version, endpoint
  origin, …) may differ only when the policy lists them in
  `comparison.allowedChanges`. Every difference is reported either way.
- **Explicit waivers.** A waiver names its rule, reason, approver, and expiry.
  Expired waivers stop applying; a waiver without a checkable expiry never
  applies.
- **Three-valued verdicts.** A metric the endpoint did not report, a missing
  baseline, or an incomparable configuration produces `inconclusive` — never a
  fabricated pass.

## Usage

```sh
# Write a conservative starter policy, then edit it.
moemodels-policy init --output policy.json

# Absolute gates only.
moemodels-policy check candidate-passport.json --policy policy.json

# Regression decision against a baseline.
moemodels-policy check candidate-passport.json \
  --policy policy.json --baseline baseline-passport.json --json

# Inspect what changed between two verified passports.
moemodels-policy compare baseline-passport.json candidate-passport.json \
  --allow runtime.version --allow endpointOrigin
```

`check` exits `0` on pass, `1` on fail, `3` on inconclusive, and `2` on usage
errors, so CI can distinguish "regressed" from "cannot decide". When
`GITHUB_STEP_SUMMARY` is set (or `--summary <path>` is given) a Markdown
receipt is appended for the job summary.

## Library

Every API except the CLI is browser-safe:

```ts
import {
  evaluateDeploymentPolicy,
  policyReceiptMarkdown,
  starterDeploymentPolicy,
} from "@moemodels/policy";

const evaluation = await evaluateDeploymentPolicy({
  policy: starterDeploymentPolicy(),
  candidate: candidatePassportJson,
  baseline: baselinePassportJson,
  evaluatedAt: new Date(),
});
console.log(evaluation.verdict, policyReceiptMarkdown(evaluation));
```

## Boundaries

A pass verdict applies only to the exact candidate configuration and the
checks the policy declares. It does not verify that the endpoint served the
declared model, runtime, or hardware, and it is not MOEModels admission,
comparison eligibility, or deployment certification.

The policy document format is specified in
[`policy.schema.json`](policy.schema.json).
