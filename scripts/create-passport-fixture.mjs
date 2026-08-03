import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  packEvidencePassport,
  runEndpointBenchmark,
  serializeEvidencePassport,
} from "../packages/bench/dist/index.js";

const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/create-passport-fixture.mjs <output.json>");

const stream = [
  'data: {"choices":[{"delta":{"content":"fixture"}}]}',
  "",
  'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

function clock() {
  let now = 0;
  return () => {
    now += 5;
    return now;
  };
}

const trials = [];
for (let index = 0; index < 3; index += 1) {
  let wallRead = 0;
  const started = Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000;
  trials.push(await runEndpointBenchmark({
    endpoint: "https://fixture.invalid/v1/chat/completions",
    model: "fixture-only/synthetic-moe",
    prompt: "synthetic protocol fixture; never publish as performance evidence",
    maxOutputTokens: 1,
    requests: 1,
    concurrency: 1,
    warmupRequests: 0,
    artifactRepository: "fixture-only/synthetic-moe",
    artifactRevision: "0".repeat(40),
    runtime: "fixture-only",
    runtimeVersion: "0.0.0-test",
    hardware: "fixture-only; no accelerator was used",
    topology: "fixture-only; no topology was used",
    now: clock(),
    wallClock: () => new Date(started + wallRead++ * 1_000),
    fetchImplementation: async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  }));
}

const passport = await packEvidencePassport(trials);
await writeFile(resolve(output), serializeEvidencePassport(passport), {
  encoding: "utf8",
  flag: "wx",
});
process.stdout.write(`Wrote synthetic protocol fixture to ${resolve(output)}.\n`);
