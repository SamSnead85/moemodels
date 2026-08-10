import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "moemodels-package-smoke-"));

function npm(args, cwd = root) {
  execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  for (const workspace of [
    "@moemodels/registry-v1",
    "@moemodels/evaluations-v1",
    "@moemodels/core",
    "@moemodels/ingest",
    "@moemodels/cli",
    "@moemodels/bench",
    "@moemodels/policy",
    "@moemodels/sdk",
    "@moemodels/mcp",
    "moemodels",
  ]) {
    npm(["pack", "--silent", "--pack-destination", temporaryDirectory, "--workspace", workspace]);
  }

  await writeFile(
    join(temporaryDirectory, "package.json"),
    `${JSON.stringify({ name: "moemodels-package-smoke", private: true }, null, 2)}\n`,
    "utf8",
  );
  const tarballs = (await readdir(temporaryDirectory))
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => join(temporaryDirectory, entry));
  assert.equal(
    tarballs.length,
    10,
    "expected registry, evaluations, core, ingest, CLI, benchmark, policy, SDK, MCP, and launcher tarballs",
  );
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], temporaryDirectory);

  const binary = join(temporaryDirectory, "node_modules", ".bin", "moemodels");
  const npxVersion = spawnSync("npx", ["--no-install", "moemodels", "--version"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  assert.equal(npxVersion.status, 0, npxVersion.stderr);
  assert.equal(npxVersion.stdout.trim(), "0.1.0");

  const validation = spawnSync(binary, ["validate", "--json"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  assert.equal(validation.status, 0, validation.stderr);
  assert.equal(JSON.parse(validation.stdout).valid, true);

  const fit = spawnSync(
    binary,
    [
      "fit",
      "moonshotai/kimi-k3",
      "--hardware",
      "nvidia/h200-sxm-141gb",
      "--devices",
      "8",
      "--devices-per-node",
      "8",
      "--reserve-bps",
      "1300",
      "--json",
    ],
    { cwd: temporaryDirectory, encoding: "utf8" },
  );
  assert.equal(fit.status, 0, fit.stderr);
  const result = JSON.parse(fit.stdout);
  assert.equal(result.staticResidency.minimumAccelerators, 13);
  assert.equal(result.staticResidency.fitsRequestedAccelerators, false);
  assert.equal(result.runtimeCompatibility.status, "unknown");

  const plan = spawnSync(
    binary,
    [
      "plan",
      "kimi-k3",
      "h200",
      "--devices",
      "16",
      "--runtime",
      "vllm",
      "--input-tokens",
      "4096",
      "--output-tokens",
      "1024",
      "--concurrency",
      "32",
      "--target-ttft-ms",
      "800",
      "--target-inter-token-ms",
      "50",
      "--availability",
      "ha",
      "--json",
    ],
    { cwd: temporaryDirectory, encoding: "utf8" },
  );
  assert.equal(plan.status, 0, plan.stderr);
  const deploymentPlan = JSON.parse(plan.stdout);
  assert.equal(deploymentPlan.kind, "deployment_validation_plan");
  assert.equal(deploymentPlan.readiness.status, "validation_required");
  assert.equal(deploymentPlan.evidencePolicy.measuredPerformanceAvailable, false);

  const evaluations = spawnSync(binary, ["evals", "--json"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  assert.equal(evaluations.status, 0, evaluations.stderr);
  assert.equal(JSON.parse(evaluations.stdout).reportedClaims.length, 15);

  const evaluationValidation = spawnSync(binary, ["validate-evals", "--json"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  assert.equal(evaluationValidation.status, 0, evaluationValidation.stderr);
  assert.equal(JSON.parse(evaluationValidation.stdout).valid, true);

  const rawEvaluation = join(temporaryDirectory, "legacy-result.json");
  await writeFile(
    rawEvaluation,
    `${JSON.stringify({
      results: { toy: { acc: 0.5, acc_stderr: 0.05 } },
      versions: { toy: 1 },
    })}\n`,
    "utf8",
  );
  const ingestion = spawnSync(
    binary,
    [
      "ingest",
      "lm-eval",
      rawEvaluation,
      "--source-url",
      "https://example.invalid/pinned/legacy-result.json",
      "--retrieved-at",
      "2026-08-03",
      "--json",
    ],
    { cwd: temporaryDirectory, encoding: "utf8" },
  );
  assert.equal(ingestion.status, 0, ingestion.stderr);
  const ingested = JSON.parse(ingestion.stdout);
  assert.equal(ingested.run.tasks[0].name, "toy");
  assert.equal(ingested.run.eligibility.status, "insufficient");

  const benchmarkBinary = join(
    temporaryDirectory,
    "node_modules",
    ".bin",
    "moemodels-bench",
  );
  const benchmarkVersion = spawnSync(benchmarkBinary, ["--version"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  assert.equal(benchmarkVersion.status, 0, benchmarkVersion.stderr);
  assert.equal(benchmarkVersion.stdout.trim(), "0.1.0");

  const policyBinary = join(
    temporaryDirectory,
    "node_modules",
    ".bin",
    "moemodels-policy",
  );
  const policyInit = spawnSync(policyBinary, ["init", "--json"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  assert.equal(policyInit.status, 0, policyInit.stderr);
  const policyValidation = spawnSync(
    policyBinary,
    ["validate-policy", join(temporaryDirectory, "policy.json")],
    { cwd: temporaryDirectory, encoding: "utf8" },
  );
  assert.equal(policyValidation.status, 0, policyValidation.stderr);
  assert.equal(JSON.parse(policyValidation.stdout).valid, true);

  const policyLaunch = spawnSync(binary, ["policy", "--help"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  assert.equal(policyLaunch.status, 0, policyLaunch.stderr);
  assert.match(policyLaunch.stdout, /moemodels-policy/);

  const sdkSmoke = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { createMoeModelsClient } from "@moemodels/sdk"; const client = createMoeModelsClient({ fetch: async () => Response.json({ registryVersion: "1.0.0", models: [] }) }); const registry = await client.registry(); if (registry.registryVersion !== "1.0.0") process.exit(1);',
    ],
    { cwd: temporaryDirectory, encoding: "utf8" },
  );
  assert.equal(sdkSmoke.status, 0, sdkSmoke.stderr);

  const mcpBinary = join(temporaryDirectory, "node_modules", ".bin", "moemodels-mcp");
  const mcpSmoke = spawnSync(mcpBinary, [], {
    cwd: temporaryDirectory,
    encoding: "utf8",
    input: [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      "",
    ].join("\n"),
  });
  assert.equal(mcpSmoke.status, 0, mcpSmoke.stderr);
  const mcpReplies = mcpSmoke.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(mcpReplies[0].result.serverInfo.name, "moemodels");
  assert.equal(mcpReplies[1].result.tools.length, 5);

  process.stdout.write("Package smoke test passed from an empty temporary project.\n");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
