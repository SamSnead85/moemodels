import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENDPOINT_BENCHMARK_ADMISSION_NOTICE,
  packEvidencePassport,
  serializeEvidencePassport,
  summarizeRequestMeasurements,
} from "@moemodels/bench";

import { starterDeploymentPolicy } from "../dist/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cliPath = join(dirname(testDirectory), "dist", "cli.js");

function makeTrial({ index = 0, ttft = [90, 110], latency = [480, 600], runtimeVersion = "0.10.0" } = {}) {
  const measurements = [0, 1].map((requestIndex) => ({
    requestIndex,
    status: "succeeded",
    httpStatus: 200,
    ttftMs: ttft[requestIndex],
    totalLatencyMs: latency[requestIndex],
    promptTokens: 18,
    outputTokens: 24,
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
      reason: "Deterministic software fixture for policy CLI tests.",
    },
    run: {
      id: `endpoint-sha256-${String(index + 1).padStart(64, "0")}`,
      startedAt: `2026-08-03T${hour}:00:00.000Z`,
      completedAt: `2026-08-03T${hour}:00:02.000Z`,
      endpointOrigin: "https://fixture.invalid",
      model: "fixture/moe-policy-demo",
      artifact: {
        binding: "exact_revision",
        repository: "fixture/moe-policy-demo",
        revision: "0123456789abcdef0123456789abcdef01234567",
      },
      runtime: { name: "fixture-runtime", version: runtimeVersion },
      infrastructure: { hardware: "fixture-accelerator", topology: "1 fixture node" },
    },
    workload: {
      protocol: "openai_chat_completions_stream",
      promptSha256: "a".repeat(64),
      promptUtf8Bytes: 96,
      maxOutputTokens: 64,
      requests: 2,
      concurrency: 1,
      warmupRequests: 0,
      temperature: 0,
    },
    summary: summarizeRequestMeasurements(measurements, 2000),
    measurements,
    missingContext: [ENDPOINT_BENCHMARK_ADMISSION_NOTICE],
    privacy: {
      promptStored: false,
      responseTextStored: false,
      apiKeyStored: false,
      statement: "The fixture contains no prompt, response, credential, or endpoint data.",
    },
  };
}

async function makePassportFile(directory, name, overrides = {}) {
  const passport = await packEvidencePassport([
    makeTrial({ index: 0, ...overrides }),
    makeTrial({ index: 1, ...overrides }),
    makeTrial({ index: 2, ...overrides }),
  ]);
  const path = join(directory, name);
  await writeFile(path, serializeEvidencePassport(passport), "utf8");
  return path;
}

function cli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("policy CLI init, check, and compare cover the verdict space", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moemodels-policy-cli-"));
  try {
    const init = cli(["init", "--output", join(directory, "policy.json"), "--json"]);
    assert.equal(init.status, 0, init.stderr);
    const initAgain = cli(["init", "--output", join(directory, "policy.json")]);
    assert.equal(initAgain.status, 2);

    const candidate = await makePassportFile(directory, "candidate.json");
    const baseline = await makePassportFile(directory, "baseline.json");
    const regressed = await makePassportFile(directory, "regressed.json", {
      ttft: [220, 260],
      latency: [1000, 1200],
      runtimeVersion: "0.11.0",
    });

    const absolutePolicy = starterDeploymentPolicy();
    absolutePolicy.rules = absolutePolicy.rules.filter((rule) => rule.kind === "absolute");
    const absolutePolicyPath = join(directory, "absolute.json");
    await writeFile(absolutePolicyPath, `${JSON.stringify(absolutePolicy, null, 2)}\n`, "utf8");

    const summaryPath = join(directory, "summary.md");
    const pass = cli(
      ["check", candidate, "--policy", absolutePolicyPath, "--json"],
      { GITHUB_STEP_SUMMARY: summaryPath },
    );
    assert.equal(pass.status, 0, pass.stderr);
    assert.equal(JSON.parse(pass.stdout).verdict, "pass");
    assert.ok((await readFile(summaryPath, "utf8")).includes("Deployment policy verdict"));

    // The full starter policy has relative rules and no baseline: inconclusive.
    const starterPath = join(directory, "starter.json");
    await writeFile(
      starterPath,
      `${JSON.stringify(starterDeploymentPolicy(), null, 2)}\n`,
      "utf8",
    );
    const inconclusive = cli(["check", candidate, "--policy", starterPath, "--json"]);
    assert.equal(inconclusive.status, 3, inconclusive.stderr);
    assert.equal(JSON.parse(inconclusive.stdout).verdict, "inconclusive");

    const fail = cli([
      "check",
      regressed,
      "--policy",
      starterPath,
      "--baseline",
      baseline,
      "--json",
    ]);
    assert.equal(fail.status, 1, fail.stderr);
    assert.equal(JSON.parse(fail.stdout).verdict, "fail");

    const green = cli([
      "check",
      candidate,
      "--policy",
      starterPath,
      "--baseline",
      baseline,
      "--json",
    ]);
    assert.equal(green.status, 0, green.stderr);
    assert.equal(JSON.parse(green.stdout).verdict, "pass");

    // The launcher forwards "policy" as a leading token; the CLI accepts it.
    const forwarded = cli(["policy", "check", candidate, "--policy", absolutePolicyPath]);
    assert.equal(forwarded.status, 0, forwarded.stderr);

    const compare = cli(["compare", baseline, regressed, "--json"]);
    assert.equal(compare.status, 1);
    const compareReport = JSON.parse(compare.stdout);
    assert.deepEqual(compareReport.unlistedChanges, ["runtime.version"]);

    const compareAllowed = cli([
      "compare",
      baseline,
      regressed,
      "--allow",
      "runtime.version",
      "--json",
    ]);
    assert.equal(compareAllowed.status, 0, compareAllowed.stderr);
    assert.equal(JSON.parse(compareAllowed.stdout).compatible, true);

    const badAllow = cli(["compare", baseline, regressed, "--allow", "vibes"]);
    assert.equal(badAllow.status, 2);

    const validate = cli(["validate-policy", starterPath]);
    assert.equal(validate.status, 0, validate.stderr);
    assert.equal(JSON.parse(validate.stdout).valid, true);

    const version = cli(["--version"]);
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), "0.1.0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
