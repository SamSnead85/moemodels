import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("validate reports the complete canonical snapshot", () => {
  const result = run(["validate", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    {
      valid: output.valid,
      models: output.models,
      hardware: output.hardware,
      compatibilityRecords: output.compatibilityRecords,
    },
    { valid: true, models: 5, hardware: 4, compatibilityRecords: 20 },
  );
});

test("models and model commands expose offline claim provenance", () => {
  const models = run(["models", "--json"]);
  assert.equal(models.status, 0, models.stderr);
  assert.equal(JSON.parse(models.stdout).models.length, 5);

  const model = run(["model", "moonshotai/kimi-k3", "--json"]);
  assert.equal(model.status, 0, model.stderr);
  const output = JSON.parse(model.stdout);
  assert.equal(output.id, "kimi-k3");
  assert.equal(output.claims.artifactTensorBytes.value, 1560860324864);
  assert.equal(output.claims.artifactTensorBytes.provenance[0].retrievedAt, "2026-08-02");
});

test("compatibility keeps runtime evidence unknown beside a static result", () => {
  const result = run(["compatibility", "kimi-k3", "h200", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const [output] = JSON.parse(result.stdout).results;
  assert.equal(output.runtimeCompatibility.status, "unknown");
  assert.equal(output.runtimeCompatibility.evidenceLevel, "unknown");
  assert.equal(output.staticResidency.minimumAccelerators, 13);
  assert.equal(output.staticResidency.topologyRoundedAccelerators, 16);

  const runtime = run([
    "compatibility",
    "moonshotai/kimi-k3",
    "--hardware",
    "nvidia/h200-sxm-141gb",
    "--runtime",
    "vllm",
    "--json",
  ]);
  assert.equal(runtime.status, 0, runtime.stderr);
  const [runtimeOutput] = JSON.parse(runtime.stdout).results;
  assert.equal(runtimeOutput.runtimeCompatibility.status, "unknown");
  assert.equal(runtimeOutput.runtimeCompatibility.framework, "vllm");
});

test("fit accepts canonical hardware aliases and evaluates requested counts", () => {
  const one = run([
    "fit",
    "google/gemma-4-26B-A4B-it",
    "nvidia/rtx-6000-ada-48gb",
    "--gpus",
    "1",
    "--json",
  ]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(JSON.parse(one.stdout).staticResidency.fitsRequestedAccelerators, false);

  const two = run([
    "fit",
    "gemma-4-26b-a4b-it",
    "rtx6000",
    "--gpus",
    "2",
    "--json",
  ]);
  assert.equal(two.status, 0, two.stderr);
  assert.equal(JSON.parse(two.stdout).staticResidency.fitsRequestedAccelerators, true);

  const documentedSyntax = run([
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
  ]);
  assert.equal(documentedSyntax.status, 0, documentedSyntax.stderr);
  const documentedOutput = JSON.parse(documentedSyntax.stdout);
  assert.equal(documentedOutput.staticResidency.minimumAccelerators, 13);
  assert.equal(documentedOutput.staticResidency.minimumNodes, 2);
  assert.equal(documentedOutput.staticResidency.fitsRequestedAccelerators, false);
});

test("identical JSON invocations are byte-identical", () => {
  const first = run(["fit", "deepseek-v4-pro", "h200", "--devices", "8", "--json"]);
  const second = run(["fit", "deepseek-v4-pro", "h200", "--devices", "8", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
});

test("plan exports an honest, reproducible deployment validation protocol", () => {
  const result = run([
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
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.kind, "deployment_validation_plan");
  assert.equal(output.readiness.status, "validation_required");
  assert.equal(output.readiness.staticResidency, "pass");
  assert.equal(output.evidencePolicy.measuredPerformanceAvailable, false);
  assert.equal(output.validationGates.length, 7);
  assert.match(output.reproducibility.apiPath, /^\/api\/v1\/plan\?/);

  const blocked = run(["plan", "kimi-k3", "h200", "--devices", "8", "--json"]);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).readiness.status, "blocked");
});

test("invalid options fail with a usage exit code", () => {
  const result = run(["models", "--gpus", "1"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not accept fit options/);
});

test("evaluation commands expose owner-reported evidence without ranking it", () => {
  const all = run(["evals", "--json"]);
  assert.equal(all.status, 0, all.stderr);
  const output = JSON.parse(all.stdout);
  assert.equal(output.evaluationSchemaVersion, "1.0.0");
  assert.equal(output.reportedClaims.length, 15);
  assert.equal(output.normalizedRuns.length, 0);
  assert.ok(output.reportedClaims.every((claim) => claim.comparisonEligible === false));

  const qwen = run(["evals", "--model", "qwen3-30b-a3b", "--json"]);
  assert.equal(qwen.status, 0, qwen.stderr);
  const qwenClaims = JSON.parse(qwen.stdout).reportedClaims;
  assert.equal(qwenClaims.length, 3);
  assert.ok(qwenClaims.every((claim) => claim.artifactAssociation === "model_name_only"));

  const record = run(["eval", qwenClaims[0].id, "--json"]);
  assert.equal(record.status, 0, record.stderr);
  assert.equal(JSON.parse(record.stdout).kind, "owner_reported_claim");
});

test("validate-evals checks the canonical evaluation registry", () => {
  const result = run(["validate-evals", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    {
      valid: true,
      target: "@moemodels/evaluations-v1",
      evaluationSchemaVersion: "1.0.0",
      sources: 9,
      reportedClaims: 15,
      normalizedRuns: 0,
    },
  );
});

test("ingest normalizes lm-eval bytes deterministically and refuses overwrites", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "moemodels-cli-ingest-"));
  try {
    const input = fileURLToPath(
      new URL("../../ingest/test/fixtures/lm-eval/hellaswag-v0-res.json", import.meta.url),
    );
    const output = join(temporaryDirectory, "normalized.json");
    const args = [
      "ingest",
      "lm-eval",
      input,
      "--source-url",
      "https://example.invalid/pinned/results.json",
      "--retrieved-at",
      "2026-08-03",
      "--output",
      output,
    ];
    const first = run(args);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Eligibility: insufficient/);
    const normalized = JSON.parse(await readFile(output, "utf8"));
    assert.equal(normalized.schemaVersion, "0.1.0");
    assert.equal(normalized.kind, "lm_eval_import");
    assert.equal(
      normalized.run.id,
      "lm-eval-sha256-61b6de31be2962ce17f8a55a15b400f95a8752de81c496970942689386ebfa1b",
    );
    assert.equal(normalized.run.tasks[0].name, "hellaswag");
    assert.equal(normalized.run.model.binding, "unresolved");

    const validatedImport = run(["validate-evals", output, "--json"]);
    assert.equal(validatedImport.status, 0, validatedImport.stderr);
    const validation = JSON.parse(validatedImport.stdout);
    assert.equal(validation.valid, true);
    assert.equal(validation.kind, "lm_eval_import");
    assert.equal(validation.publicationStatus, "incomplete");
    assert.equal(validation.eligibility.status, "insufficient");

    const overwrite = run(args);
    assert.equal(overwrite.status, 2);
    assert.match(overwrite.stderr, /Refusing to overwrite/);

    const missingSource = run([
      "ingest",
      "lm-eval",
      input,
      "--retrieved-at",
      "2026-08-03",
    ]);
    assert.equal(missingSource.status, 2);
    assert.match(missingSource.stderr, /requires --source-url/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
