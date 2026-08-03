import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LmEvalIngestionError,
  MAX_LM_EVAL_ARTIFACT_BYTES,
  inspectLmEvalArtifact,
  normalizeLmEvalArtifact,
  parseNormalizedLmEvalArtifact,
  serializeNormalizedLmEvalArtifact,
  validateNormalizedLmEvalArtifact,
} from "../dist/index.js";

const fixtureUrl = new URL("./fixtures/lm-eval/hellaswag-v0-res.json", import.meta.url);
const sourceUrl = new URL("./fixtures/lm-eval/hellaswag-v0-source.json", import.meta.url);
const fixtureBytes = new Uint8Array(await readFile(fixtureUrl));
const fixtureSource = JSON.parse(await readFile(sourceUrl, "utf8"));

function encode(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function source(overrides = {}) {
  return {
    sourceId: "synthetic-lm-eval-result",
    title: "Synthetic adapter contract fixture",
    publisher: "MOEModels tests",
    url: "https://example.invalid/pinned/results.json",
    retrievedAt: "2026-08-03",
    ...overrides,
  };
}

function modernArtifact(overrides = {}) {
  return {
    results: {
      toy_group: {
        alias: "Toy aggregate",
        "acc,none": 0.55,
        "acc_stderr,none": 0.05,
      },
      toy_task: {
        alias: "Toy task",
        "acc,none": 0.5,
        "acc_stderr,none": 0.1,
        "exact_match,strict": 0.25,
        "exact_match_stderr,strict": 0.02,
      },
    },
    groups: {
      toy_group: {
        alias: "Toy aggregate",
        "acc,none": 0.55,
        "acc_stderr,none": 0.05,
      },
    },
    group_subtasks: { toy_group: ["toy_task"] },
    configs: {
      toy_task: {
        task: "toy_task",
        dataset_path: "example/toy",
        dataset_kwargs: { revision: "0123456789abcdef0123456789abcdef01234567" },
        repeats: 1,
      },
    },
    versions: { toy_task: 1 },
    "n-shot": { toy_task: 0 },
    "higher_is_better": {
      toy_group: { acc: true },
      toy_task: { acc: true, exact_match: true },
    },
    "n-samples": { toy_task: { original: 20, effective: 10 } },
    config: {
      model: "hf",
      model_args:
        "pretrained=moonshotai/Kimi-K3,dtype=bfloat16,quantization=none,api_key=MOEMODELS_TEST_MODEL_ARG_SENTINEL,custom_option=drop-me",
      model_sha: "9f62e4e9fffbd0a83ddd60e1c209d828994b3569",
      model_dtype: "torch.bfloat16",
      batch_size: "8",
      device: "cuda:0",
      limit: null,
      random_seed: 0,
      numpy_seed: 1234,
      torch_seed: 1234,
      fewshot_seed: 1234,
      gen_kwargs: {
        temperature: 0,
        ["api" + "_" + "key"]: "MOEMODELS_TEST_GENERATION_ARG_SENTINEL",
      },
    },
    git_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    date: 1_762_318_309.331636,
    transformers_version: "4.48.0",
    lm_eval_version: "0.4.9.1",
    task_hashes: {
      toy_task: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    model_source: "hf",
    model_name: "moonshotai/Kimi-K3",
    chat_template_sha: null,
    system_instruction_sha: null,
    total_evaluation_time_seconds: "12.5",
    pretty_env_info: "Private host details that must not be copied",
    samples: {
      toy_task: [{ prompt: "private prompt", response: "private response" }],
    },
    ...overrides,
  };
}

test("pinned EleutherAI fixture retains its exact bytes and upstream digest", () => {
  const inspection = inspectLmEvalArtifact(fixtureBytes);
  assert.equal(fixtureBytes.byteLength, 196);
  assert.equal(
    inspection.sha256,
    "61b6de31be2962ce17f8a55a15b400f95a8752de81c496970942689386ebfa1b",
  );
  assert.equal(inspection.inputFamily, "legacy");
  assert.deepEqual(inspection.taskNames, ["hellaswag"]);
  assert.deepEqual(inspection.groupNames, []);
});

test("legacy fixture normalizes measured values while preserving every evidence gap", () => {
  const normalized = normalizeLmEvalArtifact(fixtureBytes, fixtureSource);
  assert.equal(
    normalized.run.id,
    "lm-eval-sha256-61b6de31be2962ce17f8a55a15b400f95a8752de81c496970942689386ebfa1b",
  );
  assert.equal(normalized.run.publicationStatus, "fixture_only");
  assert.equal(normalized.run.eligibility.status, "insufficient");
  assert.equal(normalized.run.model.binding, "unresolved");
  assert.equal(normalized.run.model.registryModelId.status, "unknown");
  assert.equal(normalized.run.harness.gitRevision.status, "unknown");
  assert.equal(normalized.run.execution.executedAt.status, "unknown");
  assert.equal(normalized.source.sourceType, "evaluation_artifact");
  assert.equal(normalized.source.license, "MIT");
  assert.match(normalized.source.licenseLocator, /LICENSE\.md$/);
  assert.equal(normalized.schemaVersion, "0.1.0");
  assert.equal(normalized.kind, "lm_eval_import");
  assert.equal(normalized.rawArtifact.kind, "lm_eval_results");
  assert.equal(normalized.rawArtifact.adapterId, "moemodels-lm-eval-import-v0-1-0");
  assert.equal(normalized.rawArtifact.byteLength, 196);

  const task = normalized.run.tasks[0];
  assert.equal(task.name, "hellaswag");
  assert.equal(task.version.status, "known");
  assert.equal(task.version.value, "0");
  assert.equal(task.fewShot.status, "unknown");
  assert.equal(task.effectiveSamples.status, "unknown");
  assert.deepEqual(
    Object.fromEntries(task.metrics.map((metric) => [metric.name, metric.value.value])),
    {
      acc: 0.24965146385182235,
      acc_norm: 0.24756024696275641,
    },
  );
  assert.deepEqual(
    Object.fromEntries(task.metrics.map((metric) => [metric.name, metric.standardError.value])),
    {
      acc: 0.004319267432460666,
      acc_norm: 0.004307128573285236,
    },
  );
  assert.ok(task.metrics.every((metric) => metric.filter.status === "unknown"));
  assert.ok(task.metrics.every((metric) => metric.higherIsBetter.status === "unknown"));
});

test("normalization and canonical serialization are byte-deterministic", () => {
  const first = normalizeLmEvalArtifact(fixtureBytes, fixtureSource);
  const second = normalizeLmEvalArtifact(fixtureBytes, fixtureSource);
  assert.equal(
    serializeNormalizedLmEvalArtifact(first),
    serializeNormalizedLmEvalArtifact(second),
  );

  const laterRetrieval = normalizeLmEvalArtifact(fixtureBytes, {
    ...fixtureSource,
    retrievedAt: "2026-08-04",
  });
  assert.equal(first.run.id, laterRetrieval.run.id);
  assert.equal(first.rawArtifact.sha256, laterRetrieval.rawArtifact.sha256);
});

test("modern v0.4 results pair metric filters and stderr without duplicating groups", () => {
  const normalized = normalizeLmEvalArtifact(encode(modernArtifact()), source());
  assert.equal(normalized.run.adapter.inputFamily, "modern-v0.4");
  assert.deepEqual(normalized.run.tasks.map((task) => task.name), ["toy_task"]);
  assert.deepEqual(normalized.run.groups.map((group) => group.name), ["toy_group"]);
  assert.deepEqual(normalized.run.groups[0].taskNames, ["toy_task"]);

  const metrics = normalized.run.tasks[0].metrics;
  assert.deepEqual(metrics.map((metric) => metric.sourceKey), ["acc,none", "exact_match,strict"]);
  assert.deepEqual(metrics.map((metric) => metric.filter.value), ["none", "strict"]);
  assert.deepEqual(metrics.map((metric) => metric.standardError.value), [0.1, 0.02]);
  assert.deepEqual(metrics.map((metric) => metric.sampleCount.value), [10, 10]);
  assert.ok(metrics.every((metric) => metric.higherIsBetter.value === true));
});

test("modern string generation kwargs normalize through the safe allowlist", () => {
  const base = modernArtifact();
  const normalized = normalizeLmEvalArtifact(
    encode(
      modernArtifact({
        config: {
          ...base.config,
          gen_kwargs: "temperature=0.2,top_p=0.95,do_sample=true,api_key=drop-me",
        },
      }),
    ),
    source(),
  );
  assert.deepEqual(normalized.run.execution.generationConfig.value, {
    do_sample: true,
    temperature: 0.2,
    top_p: 0.95,
  });
  assert.doesNotMatch(serializeNormalizedLmEvalArtifact(normalized), /drop-me/);
});

test("exact raw model SHA can bind a registry artifact but never cures other unknowns", () => {
  const normalized = normalizeLmEvalArtifact(encode(modernArtifact()), source());
  assert.equal(normalized.run.model.binding, "artifact_hash_match");
  assert.equal(normalized.run.model.registryModelId.status, "known");
  assert.equal(normalized.run.model.registryModelId.value, "kimi-k3");
  assert.equal(normalized.run.model.revision.value, "9f62e4e9fffbd0a83ddd60e1c209d828994b3569");
  assert.equal(normalized.run.harness.revisionCompleteness, "full");
  assert.equal(normalized.run.execution.hardwareTopology.status, "unknown");
  assert.equal(normalized.run.publicationStatus, "incomplete");

  const mismatch = normalizeLmEvalArtifact(
    encode(modernArtifact()),
    source({ expectedModelId: "deepseek-v4-pro" }),
  );
  assert.equal(mismatch.run.model.binding, "unresolved");
  assert.equal(mismatch.run.model.registryModelId.status, "unknown");
  assert.ok(mismatch.run.diagnostics.some((item) => item.code === "model_revision_mismatch"));

  const base = modernArtifact();
  const missingRepository = normalizeLmEvalArtifact(
    encode(
      modernArtifact({
        model_name: undefined,
        config: { ...base.config, model_args: "dtype=bfloat16" },
      }),
    ),
    source(),
  );
  assert.equal(missingRepository.run.model.binding, "artifact_hash_match");
  assert.equal(missingRepository.run.model.repository.value, "moonshotai/Kimi-K3");
  assert.equal(missingRepository.run.model.repository.evidenceClass, "calculated");

  const caseVariant = normalizeLmEvalArtifact(
    encode(modernArtifact({ model_name: "MOONSHOTAI/kimi-k3" })),
    source(),
  );
  assert.equal(caseVariant.run.model.binding, "artifact_hash_match");
  assert.equal(caseVariant.run.model.repository.value, "moonshotai/Kimi-K3");
});

test("samples, free-form environment, and unsafe arguments never enter normalized output", () => {
  const normalized = normalizeLmEvalArtifact(encode(modernArtifact()), source());
  const output = serializeNormalizedLmEvalArtifact(normalized);
  assert.doesNotMatch(output, /MOEMODELS_TEST_MODEL_ARG_SENTINEL|MOEMODELS_TEST_GENERATION_ARG_SENTINEL|private prompt|private response|Private host/);
  assert.ok(normalized.run.diagnostics.some((item) => item.code === "samples_not_ingested_v0_1"));
  assert.ok(normalized.run.diagnostics.some((item) => item.code === "freeform_environment_not_copied"));
  assert.ok(normalized.run.diagnostics.some((item) => item.code === "sensitive_model_arg_dropped"));
  assert.ok(normalized.run.diagnostics.some((item) => item.code === "sensitive_generation_arg_dropped"));
  assert.deepEqual(normalized.run.execution.generationConfig.value, { temperature: 0 });
});

test("credential-bearing repository values and source URLs fail closed", () => {
  const hostileRepository =
    "https://user:SUPERSECRET@example.com/model?access_token=ABC123";
  const base = modernArtifact();
  const normalized = normalizeLmEvalArtifact(
    encode(
      modernArtifact({
        model_name: hostileRepository,
        config: {
          ...base.config,
          model_args: `pretrained=${hostileRepository},dtype=bfloat16`,
          model_sha: undefined,
        },
      }),
    ),
    source(),
  );
  const output = serializeNormalizedLmEvalArtifact(normalized);
  assert.doesNotMatch(output, /SUPERSECRET|ABC123|access_token|user:/);
  assert.equal(normalized.run.model.repository.status, "unknown");
  assert.ok(
    normalized.run.diagnostics.some(
      (item) => item.code === "unsafe_model_repository_dropped",
    ),
  );

  assert.throws(
    () =>
      normalizeLmEvalArtifact(
        encode(modernArtifact()),
        source({ url: "https://user:password@example.invalid/results.json" }),
      ),
    (error) => error instanceof LmEvalIngestionError && error.code === "invalid_source",
  );
  for (const url of [
    "https://example.invalid/results.json?token=ABC123",
    "https://example.invalid/results.json?x-goog-signature=ABC123",
  ]) {
    assert.throws(
      () => normalizeLmEvalArtifact(encode(modernArtifact()), source({ url })),
      (error) => error instanceof LmEvalIngestionError && error.code === "invalid_source",
    );
  }
  assert.throws(
    () =>
      normalizeLmEvalArtifact(
        encode(modernArtifact()),
        source({ url: "https://example.invalid/results.json?access_token=ABC123" }),
      ),
    (error) => error instanceof LmEvalIngestionError && error.code === "invalid_source",
  );
  assert.throws(
    () =>
      normalizeLmEvalArtifact(
        encode(modernArtifact()),
        source({ publishedAt: "2026-02-30" }),
      ),
    (error) => error instanceof LmEvalIngestionError && error.code === "invalid_source",
  );
});

test("every emitted staging envelope validates and empty execution strings become unknown", () => {
  const base = modernArtifact();
  const normalized = normalizeLmEvalArtifact(
    encode(
      modernArtifact({
        model_source: "",
        config: {
          ...base.config,
          model: "",
          model_dtype: "",
          batch_size: "",
          model_args: "pretrained=moonshotai/Kimi-K3,dtype=,quantization=",
        },
      }),
    ),
    source(),
  );
  assert.equal(normalized.run.execution.backend.status, "unknown");
  assert.equal(normalized.run.execution.dtype.status, "unknown");
  assert.equal(normalized.run.execution.quantization.status, "unknown");
  assert.equal(normalized.run.execution.batchSize.status, "unknown");
  assert.deepEqual(validateNormalizedLmEvalArtifact(normalized), { valid: true, issues: [] });
  assert.doesNotThrow(() =>
    parseNormalizedLmEvalArtifact(JSON.parse(serializeNormalizedLmEvalArtifact(normalized))),
  );

  const tampered = structuredClone(normalized);
  tampered.rawArtifact.sha256 = "0".repeat(64);
  assert.throws(
    () => parseNormalizedLmEvalArtifact(tampered),
    (error) =>
      error instanceof LmEvalIngestionError && error.code === "invalid_normalized_import",
  );

  const falseEligibility = structuredClone(normalized);
  falseEligibility.run.publicationStatus = "eligible";
  falseEligibility.run.eligibility = { status: "eligible", missing: [] };
  assert.throws(
    () => parseNormalizedLmEvalArtifact(falseEligibility),
    (error) =>
      error instanceof LmEvalIngestionError &&
      error.code === "invalid_normalized_import" &&
      /recomputed/.test(error.message),
  );

  const invalidPublishedAt = structuredClone(normalized);
  invalidPublishedAt.source.publishedAt = 123;
  assert.throws(
    () => parseNormalizedLmEvalArtifact(invalidPublishedAt),
    (error) =>
      error instanceof LmEvalIngestionError &&
      /publishedAt/.test(error.message),
  );

  const falseBinding = normalizeLmEvalArtifact(fixtureBytes, fixtureSource);
  falseBinding.run.model.binding = "artifact_hash_match";
  assert.throws(
    () => parseNormalizedLmEvalArtifact(falseBinding),
    (error) =>
      error instanceof LmEvalIngestionError &&
      /artifact_hash_match/.test(error.message),
  );

  const emptyTasks = structuredClone(normalized);
  emptyTasks.run.tasks = [];
  assert.throws(
    () => parseNormalizedLmEvalArtifact(emptyTasks),
    (error) =>
      error instanceof LmEvalIngestionError && /at least one task/.test(error.message),
  );
});

test("invalid and unsafe artifact shapes fail closed", () => {
  assert.throws(
    () => inspectLmEvalArtifact(new Uint8Array()),
    (error) => error instanceof LmEvalIngestionError && error.code === "empty_artifact",
  );
  assert.throws(
    () => inspectLmEvalArtifact(new Uint8Array(MAX_LM_EVAL_ARTIFACT_BYTES + 1)),
    (error) => error instanceof LmEvalIngestionError && error.code === "artifact_too_large",
  );
  assert.throws(
    () => inspectLmEvalArtifact(new TextEncoder().encode("not json")),
    (error) => error instanceof LmEvalIngestionError && error.code === "invalid_json",
  );
  assert.throws(
    () => normalizeLmEvalArtifact(encode({ results: {}, versions: {} }), source()),
    (error) => error instanceof LmEvalIngestionError && error.code === "no_task_results",
  );
  assert.throws(
    () =>
      normalizeLmEvalArtifact(
        encode({ results: { task: { acc: "not-a-number" } }, versions: { task: 0 } }),
        source(),
      ),
    (error) => error instanceof LmEvalIngestionError && error.code === "invalid_metric",
  );
});

test("sample counts and standard errors enforce validity boundaries", () => {
  const invalidSamples = modernArtifact({
    "n-samples": { toy_task: { original: 10, effective: 11 } },
  });
  assert.throws(
    () => normalizeLmEvalArtifact(encode(invalidSamples), source()),
    (error) => error instanceof LmEvalIngestionError && error.code === "invalid_sample_count",
  );

  const invalidStderr = modernArtifact({
    results: {
      toy_task: { "acc,none": 0.5, "acc_stderr,none": -0.1 },
    },
    groups: {},
    group_subtasks: {},
  });
  assert.throws(
    () => normalizeLmEvalArtifact(encode(invalidStderr), source()),
    (error) => error instanceof LmEvalIngestionError && error.code === "invalid_metric",
  );
});
