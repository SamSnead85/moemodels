# Deployment Policy Gate v0.1

Status: implemented at `@moemodels/policy` 0.1.0.
Protocol context: [`DEPLOYBENCH_V0_1.md`](DEPLOYBENCH_V0_1.md) and
[`DEPLOYMENT_PASSPORT_V0_2.md`](DEPLOYMENT_PASSPORT_V0_2.md)

## Purpose

A DeployBench Evidence Passport preserves what was measured. The policy gate
answers the next question a reviewing team actually asks:

> Given this verified evidence, may this exact deployment change proceed?

The gate turns that review into code. A policy document declares evidence
requirements, absolute thresholds, baseline-relative regression tolerances,
an allowed identity change surface, and expiring waivers. Evaluation produces
one of exactly three verdicts:

- **pass** — every required check succeeded with complete evidence;
- **fail** — a required evidence check or rule failed;
- **inconclusive** — a metric, baseline, or comparable configuration was
  unavailable, so no honest pass or fail exists.

`inconclusive` is a first-class outcome with its own CLI exit code (`3`).
Unknown values never become passing evidence.

## Policy document

A policy is strict JSON (`moemodels_deploybench_policy`, schema `0.1.0`,
published at `packages/policy/policy.schema.json`):

```json
{
  "schemaVersion": "0.1.0",
  "kind": "moemodels_deploybench_policy",
  "name": "starter-serving-gate",
  "description": "Fail deployment review when measured serving evidence regresses.",
  "evidence": { "requireReproducibilityComplete": true },
  "comparison": { "allowedChanges": ["artifact.revision", "runtime.version", "endpointOrigin"] },
  "rules": [
    { "id": "success-rate-floor", "kind": "absolute", "metric": "success_rate",
      "aggregation": "worst_trial", "comparator": "gte", "threshold": 0.99 },
    { "id": "ttft-p95-regression", "kind": "relative", "metric": "ttft_p95_ms",
      "aggregation": "median_of_trials", "direction": "increase_is_regression",
      "tolerancePct": 10 }
  ],
  "waivers": []
}
```

Unknown fields, unknown metric or gate identifiers, duplicate rule ids,
waivers that name no rule, and unparseable expiries are rejected — a policy
that cannot be read exactly is not evaluated approximately. Every policy has a
content address (`deploybench-policy-sha256-…`) over its RFC 8785-style
canonical bytes, so a review can pin the exact policy that produced a verdict.

## Metrics

Metrics are read only from Passports that pass full verification, which has
already recomputed every stored summary from the raw request measurements:

`success_rate`, `ttft_{p50,p95,p99,mean,max}_ms`,
`latency_{p50,p95,p99,mean,max}_ms`, `request_throughput_per_second`,
`output_token_throughput_per_second`.

Aggregations across a Passport's trials: `worst_trial` (the extreme most
likely to violate the rule), `mean_of_trials`, `median_of_trials`. If any
trial cannot report a metric — for example token throughput without returned
usage — the aggregate is unknown and the rule is inconclusive.

## Baseline comparison

Relative rules compare a candidate Passport against a baseline Passport:

1. **Workload identity is mandatory.** Prompt digest, request count,
   concurrency, token limits, and protocol must match exactly; distributions
   measured under different workloads are never compared.
2. **Identity changes must be declared.** Fields such as
   `artifact.revision`, `runtime.version`, or `endpointOrigin` may differ only
   when the policy lists them in `comparison.allowedChanges`. An unlisted
   difference makes the comparison incompatible and its rules inconclusive.
3. **Every difference is reported.** The receipt names the change surface —
   what a reviewer is actually approving — rather than implying "same
   deployment".

The same aggregation is applied to both sides of a relative rule, and the
tolerance is an explicit percentage in the declared direction.

## Waivers

A waiver names its rule, reason, approver, and an expiry instant. An expired
waiver stops applying. If no evaluation instant is supplied, no waiver applies:
an unbounded waiver would silence a failing rule forever, so the engine fails
closed. Waived rules keep their underlying outcome in the receipt.

## Boundaries

- A pass verdict covers only the declared checks for the exact candidate
  configuration.
- Policy evaluation does not verify that the endpoint served the declared
  model, runtime, hardware, or topology.
- A pass is not MOEModels admission, comparison eligibility, or deployment
  certification.
- The gate never merges, averages, or republishes evidence; it reads verified
  Passports and reports.

## Surfaces

- CLI: `moemodels-policy init | check | compare | validate-policy`
  (exit codes `0` pass, `1` fail, `2` usage error, `3` inconclusive; Markdown
  receipt appended to `GITHUB_STEP_SUMMARY` when present).
- Library: browser-safe `evaluateDeploymentPolicy`, `policyReceiptMarkdown`,
  `comparePassportConfigurations`, `validateDeploymentPolicy`.
- Web: the `/passport#policy` gate runs the same engine browser-locally.
- Schema: `GET /schemas/deploybench-policy-v0.1.json`.
