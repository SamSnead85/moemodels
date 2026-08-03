import assert from "node:assert/strict";
import test from "node:test";

import { runEndpointBenchmark } from "../dist/index.js";

const streamBody = [
  'data: {"choices":[{"delta":{"content":"Hello"}}]}',
  "",
  'data: {"choices":[{"delta":{"content":" world"}}]}',
  "",
  'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

function clock() {
  let value = 0;
  return () => {
    value += 10;
    return value;
  };
}

test("runner records endpoint measurements without storing prompt, response, or secret", async () => {
  const requests = [];
  const result = await runEndpointBenchmark({
    endpoint: "https://inference.example/v1/chat/completions",
    model: "acme/exact-moe",
    prompt: "private representative prompt",
    maxOutputTokens: 32,
    requests: 2,
    concurrency: 1,
    warmupRequests: 0,
    ["api" + "Key"]: "MOEMODELS_TEST_API_KEY_REDACTION_SENTINEL",
    artifactRepository: "acme/exact-moe",
    artifactRevision: "0123456789abcdef",
    runtime: "vllm",
    runtimeVersion: "1.2.3",
    hardware: "8x H200 SXM",
    topology: "1 node; NVLink",
    now: clock(),
    wallClock: () => new Date("2026-08-03T12:00:00.000Z"),
    fetchImplementation: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(streamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  assert.equal(result.kind, "moemodels_endpoint_benchmark");
  assert.equal(result.classification.evidenceClass, "measured");
  assert.equal(result.classification.comparisonEligible, false);
  assert.equal(result.run.artifact.binding, "exact_revision");
  assert.equal(result.summary.successfulRequests, 2);
  assert.equal(result.summary.failedRequests, 0);
  assert.equal(result.summary.outputTokenThroughputPerSecond > 0, true);
  assert.equal(result.measurements[0].outputTokens, 2);
  assert.equal(result.measurements[0].outputCharacters, 11);
  assert.equal(result.privacy.promptStored, false);
  assert.equal(result.privacy.responseTextStored, false);
  assert.equal(result.privacy.apiKeyStored, false);
  assert.equal(requests.length, 2);
  assert.match(requests[0].init.headers.Authorization, /^Bearer /);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private representative prompt/);
  assert.doesNotMatch(serialized, /Hello world/);
  assert.doesNotMatch(serialized, /MOEMODELS_TEST_API_KEY_REDACTION_SENTINEL/);
});

test("runner keeps failures and missing context explicit", async () => {
  const result = await runEndpointBenchmark({
    endpoint: "http://127.0.0.1:8000/v1/chat/completions",
    model: "served-name",
    prompt: "test",
    maxOutputTokens: 8,
    requests: 1,
    concurrency: 1,
    warmupRequests: 0,
    now: clock(),
    wallClock: () => new Date("2026-08-03T12:00:00.000Z"),
    fetchImplementation: async () => new Response("unavailable", { status: 503 }),
  });

  assert.equal(result.run.artifact.binding, "endpoint_model_name_only");
  assert.equal(result.summary.successfulRequests, 0);
  assert.equal(result.summary.failedRequests, 1);
  assert.equal(result.summary.ttftMs, null);
  assert.equal(result.measurements[0].errorCode, "http_503");
  assert.ok(result.missingContext.some((item) => item.includes("Exact artifact")));
  assert.ok(result.missingContext.some((item) => item.includes("not comparison eligible")));
});

test("runner rejects embedded credentials and incomplete artifact identity", async () => {
  await assert.rejects(
    () =>
      runEndpointBenchmark({
        endpoint: "https://user:password@example.com/v1/chat/completions",
        model: "model",
        prompt: "test",
        maxOutputTokens: 8,
        requests: 1,
        concurrency: 1,
      }),
    /embedded credentials/,
  );
  await assert.rejects(
    () =>
      runEndpointBenchmark({
        endpoint: "https://example.com/v1/chat/completions",
        model: "model",
        prompt: "test",
        maxOutputTokens: 8,
        requests: 1,
        concurrency: 1,
        artifactRepository: "acme/model",
      }),
    /must be supplied together/,
  );
});
