import assert from "node:assert/strict";
import test from "node:test";

import {
  MoeModelsApiError,
  createMoeModelsClient,
} from "../dist/index.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("fit serializes exact static-fit inputs and custom headers", async () => {
  let captured;
  const client = createMoeModelsClient({
    baseUrl: "https://example.test/root/",
    headers: { "x-test": "sdk" },
    fetch: async (input, init) => {
      captured = { input: String(input), init };
      return jsonResponse({ apiVersion: "v1", registryVersion: "1.0.0", fit: {} });
    },
  });

  await client.fit({
    model: "kimi-k3",
    hardware: "h200",
    devices: 16,
    devicesPerNode: 8,
    reserveBps: 1300,
  });

  assert.equal(
    captured.input,
    "https://example.test/root/api/v1/fit?model=kimi-k3&hardware=h200&devices=16&devicesPerNode=8&reserveBps=1300",
  );
  assert.equal(captured.init.headers.get("x-test"), "sdk");
  assert.equal(captured.init.headers.get("accept"), "application/json");
});

test("plan serializes workload and SLA inputs without inventing defaults", async () => {
  let capturedUrl = "";
  const client = createMoeModelsClient({
    fetch: async (input) => {
      capturedUrl = String(input);
      return jsonResponse({
        apiVersion: "v1",
        registryVersion: "1.0.0",
        plan: { kind: "deployment_validation_plan", schemaVersion: "1.0.0" },
      });
    },
  });

  await client.plan({
    model: "kimi-k3",
    hardware: "h200",
    runtime: "vllm",
    inputTokens: 4096,
    outputTokens: 1024,
    concurrency: 32,
    targetTtftMs: 800,
    targetInterTokenMs: 50,
    availability: "ha",
  });

  const url = new URL(capturedUrl);
  assert.equal(url.pathname, "/api/v1/plan");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    model: "kimi-k3",
    hardware: "h200",
    runtime: "vllm",
    inputTokens: "4096",
    outputTokens: "1024",
    concurrency: "32",
    targetTtftMs: "800",
    targetInterTokenMs: "50",
    availability: "ha",
  });
});

test("API errors retain status, parsed body, and URL", async () => {
  const client = createMoeModelsClient({
    fetch: async () => jsonResponse({ error: "unknown_model", message: "No model." }, 404),
  });

  await assert.rejects(
    client.fit({ model: "missing", hardware: "h200" }),
    (error) => {
      assert.ok(error instanceof MoeModelsApiError);
      assert.equal(error.status, 404);
      assert.equal(error.message, "No model.");
      assert.equal(error.body.error, "unknown_model");
      return true;
    },
  );
});

test("evaluation ids are encoded as a single path segment", async () => {
  let capturedUrl = "";
  const client = createMoeModelsClient({
    fetch: async (input) => {
      capturedUrl = String(input);
      return jsonResponse({ kind: "owner_reported_claim" });
    },
  });

  await client.evaluation("claim/with space");
  assert.equal(
    capturedUrl,
    "https://moemodels.ai/api/v1/evaluations/claim%2Fwith%20space",
  );
});
