import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_DEFINITIONS,
  callTool,
  handleJsonRpcMessage,
} from "../dist/server.js";

test("server advertises five explicitly read-only evidence tools", async () => {
  const initialized = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  assert.equal(initialized.result.serverInfo.name, "moemodels");

  assert.equal(TOOL_DEFINITIONS.length, 5);
  assert.ok(TOOL_DEFINITIONS.every((tool) => tool.annotations.readOnlyHint));
  assert.match(
    TOOL_DEFINITIONS.find((tool) => tool.name === "calculate_static_checkpoint_fit").description,
    /not a runtime load test/i,
  );
});

test("static fit is labeled calculated and preserves runtime unknowns", () => {
  const result = callTool("calculate_static_checkpoint_fit", {
    model: "kimi-k3",
    hardware: "h200",
    accelerators: 16,
    acceleratorsPerNode: 8,
    reserveBasisPoints: 1300,
  });
  assert.equal(result.evidenceClass, "calculated");
  assert.equal(result.fit.status, "known");
  assert.equal(result.fit.fitsRequestedAccelerators, true);
  assert.equal(result.fit.runtimeCompatibility, "unknown");
});

test("evidence summary never turns owner-reported claims into measurements", () => {
  const result = callTool("summarize_evaluation_evidence", { model: "qwen3-30b-a3b" });
  assert.equal(result.counts.ownerReportedClaims, 3);
  assert.equal(result.counts.normalizedRuns, 0);
  assert.ok(result.ownerReportedClaims.every((claim) => claim.comparisonEligible === false));
});

test("validation plan comes from the core engine and exposes measurement gates", () => {
  const result = callTool("export_deployment_validation_plan", {
    model: "kimi-k3",
    hardware: "h200",
    accelerators: 16,
    runtime: "vllm",
    inputTokens: 4096,
    outputTokens: 1024,
    concurrency: 32,
    targetTtftMs: 800,
    targetInterTokenMs: 50,
    availability: "ha",
  });
  assert.equal(result.kind, "deployment_validation_plan");
  assert.equal(result.evidencePolicy.measuredPerformanceAvailable, false);
  assert.ok(result.validationGates.some((gate) => gate.id === "workload_sla"));
  assert.match(result.reproducibility.apiPath, /^\/api\/v1\/plan\?/);
});

test("tools/call reports invalid inputs as a tool error", async () => {
  const reply = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: "bad",
    method: "tools/call",
    params: {
      name: "calculate_static_checkpoint_fit",
      arguments: { model: "missing", hardware: "h200" },
    },
  });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /Unknown model/);
});
