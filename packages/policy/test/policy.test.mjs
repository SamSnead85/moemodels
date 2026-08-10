import assert from "node:assert/strict";
import test from "node:test";

import {
  ENDPOINT_BENCHMARK_ADMISSION_NOTICE,
  packEvidencePassport,
  summarizeRequestMeasurements,
} from "@moemodels/bench";

import {
  aggregateTrialMetric,
  comparePassportConfigurations,
  computePolicyId,
  evaluateDeploymentPolicy,
  extractTrialMetric,
  policyReceiptMarkdown,
  starterDeploymentPolicy,
  validateDeploymentPolicy,
} from "../dist/index.js";

const EVALUATED_AT = "2026-08-05T12:00:00.000Z";

function makeTrial({
  index = 0,
  ttft = [90, 110],
  latency = [480, 600],
  runtimeVersion = "0.10.0",
  revision = "0123456789abcdef0123456789abcdef01234567",
  endpointOrigin = "https://fixture.invalid",
  withUsage = true,
  requests = 2,
} = {}) {
  const measurements = Array.from({ length: requests }, (_, requestIndex) => ({
    requestIndex,
    status: "succeeded",
    httpStatus: 200,
    ttftMs: ttft[requestIndex % ttft.length],
    totalLatencyMs: latency[requestIndex % latency.length],
    promptTokens: withUsage ? 18 : null,
    outputTokens: withUsage ? 24 : null,
    outputCharacters: 112,
    errorCode: null,
  }));
  const hour = String(10 + index).padStart(2, "0");
  return {
    schemaVersion: "0.1.0",
    kind: "moemodels_endpoint_benchmark",
    classification: {
      evidenceClass: "measured",
      comparisonEligible: false,
      reason: "Deterministic software fixture for policy tests.",
    },
    run: {
      id: `endpoint-sha256-${String(index + 1).padStart(64, "0")}`,
      startedAt: `2026-08-03T${hour}:00:00.000Z`,
      completedAt: `2026-08-03T${hour}:00:02.000Z`,
      endpointOrigin,
      model: "fixture/moe-policy-demo",
      artifact: {
        binding: "exact_revision",
        repository: "fixture/moe-policy-demo",
        revision,
      },
      runtime: { name: "fixture-runtime", version: runtimeVersion },
      infrastructure: { hardware: "fixture-accelerator", topology: "1 fixture node" },
    },
    workload: {
      protocol: "openai_chat_completions_stream",
      promptSha256: "a".repeat(64),
      promptUtf8Bytes: 96,
      maxOutputTokens: 64,
      requests,
      concurrency: 1,
      warmupRequests: 0,
      temperature: 0,
    },
    summary: summarizeRequestMeasurements(measurements, 2000),
    measurements,
    missingContext: withUsage
      ? [ENDPOINT_BENCHMARK_ADMISSION_NOTICE]
      : [
          ENDPOINT_BENCHMARK_ADMISSION_NOTICE,
          "The endpoint did not return token usage.",
        ],
    privacy: {
      promptStored: false,
      responseTextStored: false,
      apiKeyStored: false,
      statement: "The fixture contains no prompt, response, credential, or endpoint data.",
    },
  };
}

async function makePassport(overrides = {}) {
  return packEvidencePassport([
    makeTrial({ index: 0, ...overrides }),
    makeTrial({ index: 1, ...overrides }),
    makeTrial({ index: 2, ...overrides }),
  ]);
}

test("starter policy validates and is content addressable", async () => {
  const policy = starterDeploymentPolicy();
  const result = validateDeploymentPolicy(policy);
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
  const policyId = await computePolicyId(policy);
  assert.match(policyId, /^deploybench-policy-sha256-[a-f0-9]{64}$/);
  assert.equal(policyId, await computePolicyId(starterDeploymentPolicy()));
});

test("validator rejects unknown fields, metrics, and dangling waivers", () => {
  const policy = starterDeploymentPolicy();
  const broken = {
    ...policy,
    surprise: true,
    rules: [
      { ...policy.rules[0], metric: "vibes" },
      policy.rules[0],
      policy.rules[0],
    ],
    waivers: [
      {
        ruleId: "not-a-rule",
        reason: "r",
        approvedBy: "a",
        expiresAt: "not-a-date",
      },
    ],
  };
  const result = validateDeploymentPolicy(broken);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes("$.surprise")));
  assert.ok(result.issues.some((issue) => issue.includes("unknown metric id")));
  assert.ok(result.issues.some((issue) => issue.includes("duplicate rule id")));
  assert.ok(result.issues.some((issue) => issue.includes("does not match a declared rule")));
  assert.ok(result.issues.some((issue) => issue.includes("ISO 8601")));
});

test("metric extraction and aggregation stay deterministic", async () => {
  const passport = await makePassport();
  const trial = passport.payload.trials[0];
  assert.equal(extractTrialMetric(trial, "success_rate"), 1);
  assert.equal(typeof extractTrialMetric(trial, "ttft_p95_ms"), "number");
  const worst = aggregateTrialMetric(passport.payload.trials, "latency_p95_ms", "worst_trial", "max");
  const best = aggregateTrialMetric(passport.payload.trials, "latency_p95_ms", "worst_trial", "min");
  assert.ok(worst >= best);
  const median = aggregateTrialMetric(passport.payload.trials, "ttft_p50_ms", "median_of_trials", "max");
  assert.equal(typeof median, "number");
});

test("aggregation is unknown when any trial misses the metric", async () => {
  const passport = await makePassport({ withUsage: false });
  assert.equal(
    aggregateTrialMetric(
      passport.payload.trials,
      "output_token_throughput_per_second",
      "mean_of_trials",
      "min",
    ),
    null,
  );
});

test("absolute rules pass a healthy verified passport", async () => {
  const passport = await makePassport();
  const policy = starterDeploymentPolicy();
  policy.rules = policy.rules.filter((rule) => rule.kind === "absolute");
  // The fixture reports 800ms-scale latencies, keep the ceiling generous.
  const evaluation = await evaluateDeploymentPolicy({
    policy,
    candidate: passport,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(evaluation.verdict, "pass");
  assert.equal(evaluation.candidate.verified, true);
  assert.ok(evaluation.rules.every((rule) => rule.outcome === "pass"));
  assert.equal(evaluation.reasons.length, 0);
});

test("an absolute threshold breach fails with an explicit reason", async () => {
  const passport = await makePassport();
  const policy = starterDeploymentPolicy();
  policy.rules = [
    {
      id: "ttft-p95-ceiling",
      kind: "absolute",
      metric: "ttft_p95_ms",
      aggregation: "worst_trial",
      comparator: "lte",
      threshold: 1,
    },
  ];
  const evaluation = await evaluateDeploymentPolicy({
    policy,
    candidate: passport,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(evaluation.verdict, "fail");
  assert.equal(evaluation.rules[0].outcome, "fail");
  assert.ok(evaluation.reasons.some((reason) => reason.includes("ttft-p95-ceiling")));
});

test("missing metrics produce inconclusive, never pass", async () => {
  const passport = await makePassport({ withUsage: false });
  const policy = starterDeploymentPolicy();
  policy.evidence.requireReproducibilityComplete = false;
  policy.rules = [
    {
      id: "token-throughput-floor",
      kind: "absolute",
      metric: "output_token_throughput_per_second",
      aggregation: "worst_trial",
      comparator: "gte",
      threshold: 1,
    },
  ];
  const evaluation = await evaluateDeploymentPolicy({
    policy,
    candidate: passport,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(evaluation.verdict, "inconclusive");
  assert.equal(evaluation.rules[0].outcome, "unknown");
});

test("incomplete reproducibility fails when the policy requires it", async () => {
  const passport = await makePassport({ withUsage: false });
  const policy = starterDeploymentPolicy();
  policy.rules = [policy.rules[0]];
  const evaluation = await evaluateDeploymentPolicy({
    policy,
    candidate: passport,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(evaluation.verdict, "fail");
  assert.ok(
    evaluation.evidenceChecks.some(
      (check) => check.id === "reproducibility_complete" && !check.passed,
    ),
  );
});

test("a tampered candidate passport fails before any rule runs", async () => {
  const passport = await makePassport();
  const tampered = structuredClone(passport);
  tampered.payload.trials[0].measurements[0].totalLatencyMs += 1;
  const evaluation = await evaluateDeploymentPolicy({
    policy: starterDeploymentPolicy(),
    candidate: tampered,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(evaluation.verdict, "fail");
  assert.equal(evaluation.candidate.verified, false);
  assert.equal(evaluation.rules.length, 0);
});

test("relative regression fails and improvement passes", async () => {
  const baseline = await makePassport();
  const regressed = await makePassport({
    ttft: [180, 220],
    latency: [900, 1100],
    runtimeVersion: "0.11.0",
  });
  const policy = starterDeploymentPolicy();
  policy.rules = [
    {
      id: "ttft-p95-regression",
      kind: "relative",
      metric: "ttft_p95_ms",
      aggregation: "median_of_trials",
      direction: "increase_is_regression",
      tolerancePct: 10,
    },
  ];
  const evaluation = await evaluateDeploymentPolicy({
    policy,
    candidate: regressed,
    baseline,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(evaluation.verdict, "fail");
  assert.equal(evaluation.rules[0].outcome, "fail");
  assert.ok(evaluation.comparison.compatible);
  assert.deepEqual(
    evaluation.comparison.identityChanges.map((change) => change.path),
    ["runtime.version"],
  );

  const improved = await makePassport({
    ttft: [60, 70],
    latency: [300, 380],
    runtimeVersion: "0.11.0",
  });
  const passEvaluation = await evaluateDeploymentPolicy({
    policy,
    candidate: improved,
    baseline,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(passEvaluation.verdict, "pass");
});

test("identity changes outside the allowed surface are inconclusive", async () => {
  const baseline = await makePassport();
  const candidate = await makePassport({
    revision: "89abcdef0123456789abcdef0123456789abcdef",
    runtimeVersion: "0.11.0",
  });
  const policy = starterDeploymentPolicy();
  policy.comparison = { allowedChanges: ["runtime.version"] };
  policy.rules = [
    {
      id: "ttft-p95-regression",
      kind: "relative",
      metric: "ttft_p95_ms",
      aggregation: "median_of_trials",
      direction: "increase_is_regression",
      tolerancePct: 10,
    },
  ];
  const evaluation = await evaluateDeploymentPolicy({
    policy,
    candidate,
    baseline,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(evaluation.verdict, "inconclusive");
  assert.equal(evaluation.comparison.compatible, false);
  assert.deepEqual(evaluation.comparison.unlistedChanges, ["artifact.revision"]);
});

test("a relative rule without a baseline is inconclusive", async () => {
  const candidate = await makePassport();
  const policy = starterDeploymentPolicy();
  const evaluation = await evaluateDeploymentPolicy({
    policy,
    candidate,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(evaluation.verdict, "inconclusive");
  assert.ok(
    evaluation.rules
      .filter((rule) => rule.kind === "relative")
      .every((rule) => rule.outcome === "unknown"),
  );
});

test("waivers apply until they expire and never after", async () => {
  const passport = await makePassport();
  const policy = starterDeploymentPolicy();
  policy.rules = [
    {
      id: "ttft-p95-ceiling",
      kind: "absolute",
      metric: "ttft_p95_ms",
      aggregation: "worst_trial",
      comparator: "lte",
      threshold: 1,
    },
  ];
  policy.waivers = [
    {
      ruleId: "ttft-p95-ceiling",
      reason: "Known cold-start regression tracked in issue #42.",
      approvedBy: "deploy-review",
      expiresAt: "2026-09-01T00:00:00Z",
    },
  ];
  const waived = await evaluateDeploymentPolicy({
    policy,
    candidate: passport,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(waived.verdict, "pass");
  assert.equal(waived.rules[0].outcome, "waived");
  assert.equal(waived.rules[0].underlyingOutcome, "fail");
  assert.equal(waived.waivers[0].status, "applied");

  const expired = await evaluateDeploymentPolicy({
    policy,
    candidate: passport,
    evaluatedAt: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(expired.verdict, "fail");
  assert.equal(expired.waivers[0].status, "expired");

  const noInstant = await evaluateDeploymentPolicy({
    policy,
    candidate: passport,
  });
  assert.equal(noInstant.verdict, "fail");
});

test("configuration comparison reports workload mismatches", async () => {
  const baseline = await makePassport();
  const candidate = await makePassport({ requests: 4 });
  const report = comparePassportConfigurations(
    baseline.payload.trials[0],
    candidate.payload.trials[0],
    [],
  );
  assert.equal(report.workloadCompatible, false);
  assert.equal(report.compatible, false);
});

test("the receipt names the verdict, rules, and boundaries", async () => {
  const passport = await makePassport();
  const policy = starterDeploymentPolicy();
  policy.rules = policy.rules.filter((rule) => rule.kind === "absolute");
  const evaluation = await evaluateDeploymentPolicy({
    policy,
    candidate: passport,
    evaluatedAt: EVALUATED_AT,
  });
  const receipt = policyReceiptMarkdown(evaluation);
  assert.ok(receipt.includes("Deployment policy verdict"));
  assert.ok(receipt.includes("success-rate-floor"));
  assert.ok(receipt.includes("not MOEModels admission"));
});

test("an invalid policy document throws with issues attached", async () => {
  const passport = await makePassport();
  await assert.rejects(
    evaluateDeploymentPolicy({
      policy: { kind: "wrong" },
      candidate: passport,
    }),
    (error) => {
      assert.equal(error.name, "DeploymentPolicyError");
      assert.ok(error.issues.length > 0);
      return true;
    },
  );
});
