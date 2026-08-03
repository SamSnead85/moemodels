import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeploymentPlan,
  findHardware,
  findModel,
  registry,
} from "../dist/index.js";

function model(id) {
  const value = findModel(id);
  assert.ok(value, `expected model ${id}`);
  return value;
}

function hardware(id) {
  const value = findHardware(id);
  assert.ok(value, `expected hardware ${id}`);
  return value;
}

function plan(overrides = {}) {
  return buildDeploymentPlan({
    model: model("kimi-k3"),
    hardware: hardware("h200"),
    compatibility: registry.compatibility,
    requestedAccelerators: 16,
    acceleratorsPerNode: 8,
    reserveBasisPoints: 1300,
    runtime: "vllm",
    workload: {
      inputTokens: 4096,
      outputTokens: 1024,
      concurrency: 32,
      targetTtftMs: 800,
      targetInterTokenMs: 50,
      availability: "ha",
    },
    ...overrides,
  });
}

test("deployment plan clears only the calculated static floor", () => {
  const result = plan();

  assert.equal(result.schemaVersion, "1.0.0");
  assert.equal(result.kind, "deployment_validation_plan");
  assert.equal(result.readiness.status, "validation_required");
  assert.equal(result.readiness.staticResidency, "pass");
  assert.equal(result.readiness.runtimeCompatibility, "unknown");
  assert.equal(result.evidencePolicy.resultClass, "calculated");
  assert.equal(result.evidencePolicy.measuredPerformanceAvailable, false);
  assert.equal(result.dimensions.load.status, "conditional");
  assert.equal(result.dimensions.run.status, "unknown");
  assert.equal(result.dimensions.scale.status, "unknown");
  assert.equal(result.dimensions.economics.status, "unknown");
  assert.equal(result.validationGates.length, 7);
  assert.equal(result.validationGates[1].status, "calculated_pass");
  assert.equal(result.validationGates[4].status, "required");
  assert.match(result.reproducibility.cli, /moemodels plan kimi-k3 h200/);
  assert.match(result.reproducibility.apiPath, /^\/api\/v1\/plan\?/);
  assert.doesNotMatch(JSON.stringify(result), /predictedThroughput|monthlyCost|officialRank/);
});

test("deployment plan blocks a topology below the static checkpoint floor", () => {
  const result = plan({ requestedAccelerators: 8 });

  assert.equal(result.readiness.status, "blocked");
  assert.equal(result.readiness.staticResidency, "fail");
  assert.equal(result.nextAction.code, "increase_capacity");
  assert.match(result.nextAction.summary, /at least 13 accelerator/);
  assert.equal(result.validationGates[1].status, "blocked");
  assert.ok(result.validationGates.slice(2).every((gate) => gate.status === "blocked"));
});

test("identical plan inputs produce byte-identical JSON", () => {
  const first = JSON.stringify(plan());
  const second = JSON.stringify(plan());
  assert.equal(first, second);
});

test("deployment plan rejects unsafe or ambiguous execution inputs", () => {
  assert.throws(() => plan({ requestedAccelerators: 0 }), /positive safe integer/);
  assert.throws(() => plan({ runtime: "vllm --trust-everything" }), /runtime must be/);
  assert.throws(
    () =>
      plan({
        workload: {
          inputTokens: 4096,
          outputTokens: 1024,
          concurrency: 0,
          targetTtftMs: 800,
          targetInterTokenMs: 50,
          availability: "ha",
        },
      }),
    /workload\.concurrency/,
  );
});
