import assert from "node:assert/strict";
import test from "node:test";

import {
  EvaluationValidationError,
  evaluationRegistry,
  listEvaluationArtifactsForRunFromRegistry,
  listEvaluationSourcesForRunFromRegistry,
  listReportedBenchmarkClaims,
  parseEvaluationRegistry,
  registry,
} from "../dist/index.js";

const hashes = {
  artifact: "a".repeat(64),
  task: "b".repeat(64),
  chat: "c".repeat(64),
  system: "d".repeat(64),
  reasoning: "e".repeat(64),
  sampling: "f".repeat(64),
};

function addValidNormalizedRun(candidate) {
  const model = registry.models.find((item) => item.id === "kimi-k3");
  const adapter = candidate.adapters[0];
  const runId = "normalized-kimi-k3-gpqa-run-1";
  const rawArtifactId = "raw-kimi-k3-gpqa-run-1";
  const manifestArtifactId = "manifest-kimi-k3-gpqa-run-1";
  const sourceId = "normalized-kimi-k3-gpqa-run-1-source";
  const manifestSourceId = "normalized-kimi-k3-gpqa-run-1-manifest-source";
  const sourceUrl = "https://example.invalid/evidence/kimi-k3-gpqa-run-1.json";
  const manifestUrl = "https://example.invalid/evidence/kimi-k3-gpqa-run-1-manifest.json";
  candidate.sources.push({
    id: sourceId,
    title: "Kimi K3 GPQA raw lm-eval result",
    publisher: "MOEModels test operator",
    url: sourceUrl,
    retrievedAt: "2026-08-03",
    sourceType: "evaluation_artifact",
    license: "CC0-1.0",
  });
  candidate.sources.push({
    id: manifestSourceId,
    title: "Kimi K3 GPQA canonical run manifest",
    publisher: "MOEModels test operator",
    url: manifestUrl,
    retrievedAt: "2026-08-03",
    sourceType: "evaluation_artifact",
    license: "CC0-1.0",
  });
  candidate.rawArtifacts.push({
    id: rawArtifactId,
    runId,
    adapterId: adapter.id,
    sourceId,
    kind: "lm_eval_results",
    mediaType: "application/json",
    uri: sourceUrl,
    sha256: hashes.artifact,
    byteLength: 1024,
  });
  candidate.rawArtifacts.push({
    id: manifestArtifactId,
    runId,
    adapterId: adapter.id,
    sourceId: manifestSourceId,
    kind: "run_manifest",
    mediaType: "application/json",
    uri: manifestUrl,
    sha256: "9".repeat(64),
    byteLength: 2048,
  });
  candidate.runs.push({
    id: runId,
    runType: "normalized",
    adapterId: adapter.id,
    modelId: model.id,
    artifact: {
      repository: model.artifact.repository,
      revision: model.artifact.revision,
    },
    executionArtifactDigest: hashes.artifact,
    benchmark: { suite: "GPQA", version: "1.0", subset: "Diamond" },
    metrics: [
      {
        sourceKey: "exact_match,none",
        name: "exact_match",
        filter: "none",
        value: 0.75,
        standardError: 0.03,
        sampleCount: 198,
        unit: "proportion",
        direction: "higher_is_better",
      },
    ],
    settings: [{ name: "reasoning_effort", value: "high" }],
    fingerprint: {
      canonicalization: {
        scheme: "RFC8785",
        textEncoding: "UTF-8",
        absentValue: "JSON null",
        hardwareRegistryVersion: "1.0.0",
      },
      harness: {
        name: "lm-evaluation-harness",
        version: adapter.version,
        revision: adapter.revision,
      },
      task: {
        hash: hashes.task,
        version: "1.0",
        datasetRevision: "1".repeat(40),
      },
      chatTemplateSha256: hashes.chat,
      systemPromptSha256: hashes.system,
      reasoningConfigSha256: hashes.reasoning,
      samplingConfigSha256: hashes.sampling,
      seeds: { random: 0, numpy: 1234, torch: 1234, fewshot: 1234 },
      samples: { original: 198, effective: 198, limit: null, repetitions: 1 },
      runtime: { name: "transformers", version: "4.48.0", precision: "bfloat16" },
      hardware: {
        acceleratorId: "h200",
        acceleratorCount: 8,
        nodeCount: 1,
        devicesPerNode: 8,
        interconnect: "nvlink-4",
      },
    },
    rawArtifactIds: [rawArtifactId, manifestArtifactId],
    startedAt: "2026-08-03T00:00:00Z",
    completedAt: "2026-08-03T00:30:00Z",
    comparisonEligible: true,
    comparisonEligibilityReasons: [],
  });
  return candidate.runs.at(-1);
}

test("canonical evaluation evidence validates without inventing comparable runs", () => {
  assert.equal(evaluationRegistry.schemaVersion, "1.0.0");
  assert.equal(evaluationRegistry.sources.length, 9);
  assert.equal(evaluationRegistry.adapters.length, 1);
  assert.equal(evaluationRegistry.reportedClaims.length, 15);
  assert.equal(evaluationRegistry.runs.length, 0);
  assert.equal(
    evaluationRegistry.reportedClaims.filter(
      (claim) => claim.artifactAssociation === "artifact_snapshot_associated",
    ).length,
    12,
  );
  assert.equal(
    evaluationRegistry.reportedClaims.filter(
      (claim) => claim.artifactAssociation === "model_name_only",
    ).length,
    3,
  );
  assert.ok(
    evaluationRegistry.reportedClaims.every(
      (claim) =>
        claim.executionArtifactDigest === null &&
        claim.comparisonEligible === false &&
        claim.missingContext.length > 0,
    ),
  );
});

test("reported claim queries remain model-scoped", () => {
  const kimi = listReportedBenchmarkClaims("kimi-k3");
  assert.equal(kimi.length, 3);
  assert.ok(kimi.every((claim) => claim.modelId === "kimi-k3"));
  assert.deepEqual(
    kimi.map((claim) => claim.benchmark.suite).sort(),
    ["BrowseComp", "GPQA", "Terminal-Bench"],
  );
});

test("evaluation validator rejects dangling source references", () => {
  const candidate = structuredClone(evaluationRegistry);
  candidate.reportedClaims[0].sourceRefs[0].sourceId = "missing-source";
  assert.throws(
    () => parseEvaluationRegistry(candidate, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("unknown source missing-source")),
  );
});

test("evaluation validator rejects duplicate records and mutable revisions", () => {
  const duplicate = structuredClone(evaluationRegistry);
  duplicate.reportedClaims.push(structuredClone(duplicate.reportedClaims[0]));
  assert.throws(
    () => parseEvaluationRegistry(duplicate, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("duplicate")),
  );

  const mutable = structuredClone(evaluationRegistry);
  mutable.reportedClaims[0].artifact.revision = "main";
  assert.throws(
    () => parseEvaluationRegistry(mutable, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("pinned 40-character revision")),
  );
});

test("published runs require the complete comparability fingerprint and exact bindings", () => {
  const valid = structuredClone(evaluationRegistry);
  addValidNormalizedRun(valid);
  const parsed = parseEvaluationRegistry(valid, registry);
  assert.deepEqual(
    listEvaluationSourcesForRunFromRegistry(parsed, parsed.runs[0].id).map(
      (source) => source.id,
    ),
    [
      "normalized-kimi-k3-gpqa-run-1-source",
      "normalized-kimi-k3-gpqa-run-1-manifest-source",
    ],
  );
  assert.deepEqual(
    listEvaluationArtifactsForRunFromRegistry(parsed, parsed.runs[0].id).map(
      (artifact) => artifact.kind,
    ),
    ["lm_eval_results", "run_manifest"],
  );

  const mismatchedArtifact = structuredClone(valid);
  mismatchedArtifact.runs[0].artifact.repository = "deepseek-ai/DeepSeek-V4-Pro";
  assert.throws(
    () => parseEvaluationRegistry(mismatchedArtifact, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("must exactly match")),
  );

  const missingFingerprint = structuredClone(valid);
  delete missingFingerprint.runs[0].fingerprint;
  assert.throws(
    () => parseEvaluationRegistry(missingFingerprint, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("fingerprint: missing property")),
  );

  const digestMismatch = structuredClone(valid);
  digestMismatch.runs[0].executionArtifactDigest = "0".repeat(64);
  assert.throws(
    () => parseEvaluationRegistry(digestMismatch, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("lm_eval_results digest")),
  );

  const sampleMismatch = structuredClone(valid);
  sampleMismatch.runs[0].fingerprint.samples.effective = 1;
  assert.throws(
    () => parseEvaluationRegistry(sampleMismatch, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("sampleCount")),
  );

  const taskVersionMismatch = structuredClone(valid);
  taskVersionMismatch.runs[0].fingerprint.task.version = "different-v";
  assert.throws(
    () => parseEvaluationRegistry(taskVersionMismatch, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("fingerprint.task.version")),
  );

  const topologyMismatch = structuredClone(valid);
  topologyMismatch.runs[0].fingerprint.hardware.nodeCount = 2;
  assert.throws(
    () => parseEvaluationRegistry(topologyMismatch, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("nodeCount × devicesPerNode")),
  );

  const noManifest = structuredClone(valid);
  noManifest.runs[0].rawArtifactIds = [noManifest.runs[0].rawArtifactIds[0]];
  assert.throws(
    () => parseEvaluationRegistry(noManifest, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("run_manifest")),
  );

  const duplicateEvidenceId = structuredClone(valid);
  duplicateEvidenceId.runs[0].id = duplicateEvidenceId.reportedClaims[0].id;
  assert.throws(
    () => parseEvaluationRegistry(duplicateEvidenceId, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("duplicate evidence record id")),
  );

  const orphanArtifact = structuredClone(valid);
  orphanArtifact.rawArtifacts.push({
    ...structuredClone(orphanArtifact.rawArtifacts[1]),
    id: "orphan-kimi-k3-gpqa-run-1-samples",
    kind: "lm_eval_samples",
    sha256: "8".repeat(64),
  });
  assert.throws(
    () => parseEvaluationRegistry(orphanArtifact, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("not referenced by its owning run")),
  );
});

test("owner-reported artifact associations cannot be swapped across model records", () => {
  const wrongArtifact = structuredClone(evaluationRegistry);
  wrongArtifact.reportedClaims[0].artifact = structuredClone(
    registry.models.find((model) => model.id === "deepseek-v4-pro").artifact,
  );
  delete wrongArtifact.reportedClaims[0].artifact.provenance;
  assert.throws(
    () => parseEvaluationRegistry(wrongArtifact, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("must exactly match")),
  );

  const wrongSource = structuredClone(evaluationRegistry);
  wrongSource.reportedClaims[0].sourceRefs[0].sourceId =
    "qwen3-30b-a3b-pinned-model-card";
  assert.throws(
    () => parseEvaluationRegistry(wrongSource, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("pinned to the same artifact")),
  );
});

test("evaluation source URLs reject embedded credentials and sensitive query keys", () => {
  for (const url of [
    "https://alice:supersecret@example.invalid/results.json",
    "https://example.invalid/results.json?api_key=supersecret",
    "https://example.invalid/results.json?token=supersecret",
    "https://example.invalid/results.json?x-amz-signature=supersecret",
  ]) {
    const candidate = structuredClone(evaluationRegistry);
    candidate.sources[0].url = url;
    assert.throws(
      () => parseEvaluationRegistry(candidate, registry),
      (error) =>
        error instanceof EvaluationValidationError &&
        error.issues.some((issue) => issue.includes("credentials and sensitive")),
    );
  }
});

test("evaluation registry enforces the declared adapter pin and non-empty evidence sets", () => {
  const wrongAdapter = structuredClone(evaluationRegistry);
  wrongAdapter.adapters[0].revision = "0".repeat(40);
  assert.throws(
    () => parseEvaluationRegistry(wrongAdapter, registry),
    (error) =>
      error instanceof EvaluationValidationError &&
      error.issues.some((issue) => issue.includes("reference-harness commit")),
  );

  for (const field of ["sources", "adapters", "reportedClaims"]) {
    const empty = structuredClone(evaluationRegistry);
    empty[field] = [];
    assert.throws(
      () => parseEvaluationRegistry(empty, registry),
      (error) =>
        error instanceof EvaluationValidationError &&
        error.issues.some((issue) => issue.includes("expected at least one")),
    );
  }
});
