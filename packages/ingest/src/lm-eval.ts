import { createHash } from "node:crypto";

import {
  findModel,
  evaluationRunEligibilityMissing,
  registry,
  validateEvaluationRun,
  type EvaluationClaim,
  type EvaluationEvidenceClass,
  type EvaluationGroupResult,
  type EvaluationMetric,
  type EvaluationRun,
  type EvaluationSource,
  type EvaluationTaskResult,
  type IngestionDiagnostic,
  type ProvenanceRef,
  type RawEvaluationArtifact,
} from "@moemodels/core";

export const MAX_LM_EVAL_ARTIFACT_BYTES = 10 * 1024 * 1024;

const ADAPTER_VERSION = "0.1.0" as const;
const INGEST_ADAPTER_ID = "moemodels-lm-eval-import-v0-1-0" as const;
const IMPORT_SCHEMA_VERSION = "0.1.0" as const;
const SENSITIVE_KEY =
  /(api[_-]?key|access[_-]?token|auth|bearer|credential|password|secret|(?:^|[_-])(?:token|key|sig|signature)$)/i;
const CANONICAL_MODEL_REPOSITORY =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const MODEL_ARG_ALLOWLIST = new Set([
  "pretrained",
  "revision",
  "dtype",
  "quantization",
  "load_in_4bit",
  "load_in_8bit",
]);
const GENERATION_ALLOWLIST = new Set([
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "max_gen_toks",
  "max_new_tokens",
  "do_sample",
  "until",
]);
const STRUCTURAL_RESULT_KEYS = new Set(["alias", "name", "sample_len", "sample_count"]);

type JsonObject = Record<string, unknown>;

export interface LmEvalImportSourceMetadata {
  sourceId: string;
  title: string;
  publisher: string;
  url: string;
  retrievedAt: string;
  publishedAt?: string;
  locator?: string;
  fixture?: boolean;
  expectedModelId?: string;
  license?: string;
  licenseLocator?: string;
}

/** @deprecated Use LmEvalImportSourceMetadata. */
export type LmEvalImportSource = LmEvalImportSourceMetadata;

export interface LmEvalInspection {
  sha256: string;
  bytes: number;
  inputFamily: "legacy" | "modern-v0.4";
  taskNames: string[];
  groupNames: string[];
}

export interface NormalizedLmEvalArtifact {
  schemaVersion: "0.1.0";
  kind: "lm_eval_import";
  source: EvaluationSource;
  rawArtifact: RawEvaluationArtifact;
  run: EvaluationRun;
}

export class LmEvalIngestionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LmEvalIngestionError";
    this.code = code;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalObject(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

function requiredObject(value: unknown, locator: string): JsonObject {
  if (!isObject(value)) {
    throw new LmEvalIngestionError("invalid_shape", `${locator} must be an object.`);
  }
  return value;
}

function sourceLocator(...segments: string[]): string {
  return `$${segments.map((segment) => `[${JSON.stringify(segment)}]`).join("")}`;
}

function provenance(sourceId: string, locator: string): ProvenanceRef[] {
  return [{ sourceId, locator }];
}

function known<T>(
  value: T,
  evidenceClass: EvaluationEvidenceClass,
  sourceId: string,
  locator: string,
): EvaluationClaim<T> {
  return { status: "known", value, evidenceClass, provenance: provenance(sourceId, locator) };
}

function unknown<T>(reason: string, sourceId: string, locator: string): EvaluationClaim<T> {
  return { status: "unknown", reason, provenance: provenance(sourceId, locator) };
}

function diagnostic(
  diagnostics: IngestionDiagnostic[],
  code: string,
  message: string,
  locator?: string,
  severity: IngestionDiagnostic["severity"] = "warning",
): void {
  diagnostics.push({
    code,
    severity,
    message,
    ...(locator === undefined ? {} : { locator }),
  });
}

function decodeArtifact(bytes: Uint8Array): { parsed: JsonObject; sha256: string } {
  if (bytes.byteLength === 0) {
    throw new LmEvalIngestionError("empty_artifact", "The lm-eval artifact is empty.");
  }
  if (bytes.byteLength > MAX_LM_EVAL_ARTIFACT_BYTES) {
    throw new LmEvalIngestionError(
      "artifact_too_large",
      `Aggregated lm-eval JSON cannot exceed ${MAX_LM_EVAL_ARTIFACT_BYTES} bytes.`,
    );
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LmEvalIngestionError("invalid_utf8", "The lm-eval artifact must be valid UTF-8.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new LmEvalIngestionError("invalid_json", "The lm-eval artifact must be valid JSON.");
  }
  if (!isObject(parsed)) {
    throw new LmEvalIngestionError("invalid_shape", "The lm-eval artifact root must be an object.");
  }
  requiredObject(parsed.results, "$.results");
  return { parsed, sha256 };
}

function detectInputFamily(parsed: JsonObject): "legacy" | "modern-v0.4" {
  const modernKeys = [
    "configs",
    "n-shot",
    "n-samples",
    "config",
    "git_hash",
    "lm_eval_version",
    "task_hashes",
  ];
  if (modernKeys.some((key) => hasOwn(parsed, key))) return "modern-v0.4";
  if (isObject(parsed.versions)) return "legacy";
  throw new LmEvalIngestionError(
    "unrecognized_lm_eval_shape",
    "Expected a legacy results/versions artifact or a modern lm-eval v0.4 result.",
  );
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function validateImportSource(source: LmEvalImportSourceMetadata): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(source.sourceId)) {
    throw new LmEvalIngestionError("invalid_source", "sourceId must be a lowercase slug.");
  }
  for (const [name, value] of [
    ["title", source.title],
    ["publisher", source.publisher],
  ] as const) {
    if (value.trim() === "") {
      throw new LmEvalIngestionError("invalid_source", `${name} must be non-empty.`);
    }
  }
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new LmEvalIngestionError("invalid_source", "url must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") {
    throw new LmEvalIngestionError("invalid_source", "url must be a valid HTTPS URL.");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    [...url.searchParams.keys()].some((key) => SENSITIVE_KEY.test(key))
  ) {
    throw new LmEvalIngestionError(
      "invalid_source",
      "url must not contain credentials or sensitive query parameters.",
    );
  }
  if (!isValidDateOnly(source.retrievedAt)) {
    throw new LmEvalIngestionError("invalid_source", "retrievedAt must use YYYY-MM-DD.");
  }
  if (source.publishedAt !== undefined && !isValidDateOnly(source.publishedAt)) {
    throw new LmEvalIngestionError("invalid_source", "publishedAt must use YYYY-MM-DD.");
  }
  for (const [name, value] of [
    ["locator", source.locator],
    ["license", source.license],
    ["licenseLocator", source.licenseLocator],
  ] as const) {
    if (value !== undefined && value.trim() === "") {
      throw new LmEvalIngestionError("invalid_source", `${name} must be non-empty when provided.`);
    }
  }
}

function inspectParsed(
  parsed: JsonObject,
  sha256: string,
  bytes: number,
): LmEvalInspection {
  const results = requiredObject(parsed.results, "$.results");
  const groups = optionalObject(parsed.groups) ?? {};
  const groupNames = Object.keys(groups).sort();
  const groupSet = new Set(groupNames);
  const taskNames = Object.keys(results)
    .filter((name) => !groupSet.has(name))
    .sort();
  if (taskNames.length === 0) {
    throw new LmEvalIngestionError("no_task_results", "The artifact contains no task results.");
  }
  return {
    sha256,
    bytes,
    inputFamily: detectInputFamily(parsed),
    taskNames,
    groupNames,
  };
}

export function inspectLmEvalArtifact(bytes: Uint8Array): LmEvalInspection {
  const decoded = decodeArtifact(bytes);
  return inspectParsed(decoded.parsed, decoded.sha256, bytes.byteLength);
}

function parseSafeModelArgs(
  value: unknown,
  diagnostics: IngestionDiagnostic[],
): Map<string, string | number | boolean | null> {
  const output = new Map<string, string | number | boolean | null>();
  const accept = (key: string, rawValue: unknown, locator: string): void => {
    const normalizedKey = key.trim().toLowerCase();
    if (!MODEL_ARG_ALLOWLIST.has(normalizedKey)) {
      diagnostic(
        diagnostics,
        SENSITIVE_KEY.test(normalizedKey) ? "sensitive_model_arg_dropped" : "model_arg_dropped",
        SENSITIVE_KEY.test(normalizedKey)
          ? `Sensitive model argument “${normalizedKey}” was dropped.`
          : `Unrecognized model argument “${normalizedKey}” was dropped.`,
        locator,
      );
      return;
    }
    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean" &&
      rawValue !== null
    ) {
      diagnostic(
        diagnostics,
        "model_arg_dropped",
        `Non-scalar model argument “${normalizedKey}” was dropped.`,
        locator,
      );
      return;
    }
    output.set(normalizedKey, rawValue);
  };

  if (typeof value === "string") {
    value.split(",").forEach((part, index) => {
      const separator = part.indexOf("=");
      if (separator <= 0) {
        diagnostic(
          diagnostics,
          "model_arg_dropped",
          "A model argument without a key/value separator was dropped.",
          sourceLocator("config", "model_args", String(index)),
        );
        return;
      }
      const key = part.slice(0, separator).trim();
      const rawValue = part.slice(separator + 1).trim();
      accept(key, rawValue, sourceLocator("config", "model_args", key));
    });
  } else if (isObject(value)) {
    Object.keys(value)
      .sort()
      .forEach((key) => accept(key, value[key], sourceLocator("config", "model_args", key)));
  } else if (value !== undefined && value !== null) {
    diagnostic(
      diagnostics,
      "model_args_dropped",
      "model_args was not a string or object and was dropped.",
      sourceLocator("config", "model_args"),
    );
  }
  return output;
}

function safeGenerationConfig(
  value: unknown,
  sourceId: string,
  diagnostics: IngestionDiagnostic[],
): EvaluationClaim<Record<string, unknown> | null> {
  const locator = sourceLocator("config", "gen_kwargs");
  if (value === null) return known(null, "sourced", sourceId, locator);
  if (value === undefined) {
    return unknown("The raw artifact does not report generation configuration.", sourceId, locator);
  }
  let config: JsonObject;
  if (typeof value === "string") {
    config = {};
    value.split(",").forEach((part, index) => {
      const separator = part.indexOf("=");
      if (separator <= 0) {
        diagnostic(
          diagnostics,
          "generation_arg_dropped",
          "A generation argument without a key/value separator was dropped.",
          sourceLocator("config", "gen_kwargs", String(index)),
        );
        return;
      }
      const key = part.slice(0, separator).trim();
      const rawEntry = part.slice(separator + 1).trim();
      if (!GENERATION_ALLOWLIST.has(key)) {
        diagnostic(
          diagnostics,
          SENSITIVE_KEY.test(key)
            ? "sensitive_generation_arg_dropped"
            : "generation_arg_dropped",
          SENSITIVE_KEY.test(key)
            ? `Sensitive generation argument “${key}” was dropped.`
            : `Unrecognized generation argument “${key}” was dropped.`,
          sourceLocator("config", "gen_kwargs", key),
        );
        return;
      }
      if (/^(?:true|false)$/i.test(rawEntry)) {
        config[key] = rawEntry.toLowerCase() === "true";
      } else if (/^null$/i.test(rawEntry)) {
        config[key] = null;
      } else if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(rawEntry)) {
        const numeric = Number(rawEntry);
        config[key] = Number.isFinite(numeric) ? numeric : rawEntry;
      } else {
        config[key] = rawEntry;
      }
    });
  } else if (isObject(value)) {
    config = value;
  } else {
    diagnostic(
      diagnostics,
      "generation_config_dropped",
      "Generation configuration was neither a string nor an object and was dropped.",
      locator,
    );
    return unknown("Generation configuration was not safely structured.", sourceId, locator);
  }

  const safe: Record<string, unknown> = {};
  Object.keys(config)
    .sort()
    .forEach((key) => {
      const entry = config[key];
      if (
        GENERATION_ALLOWLIST.has(key) &&
        (entry === null ||
          typeof entry === "string" ||
          typeof entry === "number" ||
          typeof entry === "boolean" ||
          (Array.isArray(entry) && entry.every((item) => typeof item === "string")))
      ) {
        safe[key] = entry;
      } else {
        diagnostic(
          diagnostics,
          SENSITIVE_KEY.test(key) ? "sensitive_generation_arg_dropped" : "generation_arg_dropped",
          SENSITIVE_KEY.test(key)
            ? `Sensitive generation argument “${key}” was dropped.`
            : `Unrecognized generation argument “${key}” was dropped.`,
          sourceLocator("config", "gen_kwargs", key),
        );
      }
    });
  if (Object.keys(safe).length === 0 && Object.keys(config).length > 0) {
    return unknown("No generation settings survived the safe allowlist.", sourceId, locator);
  }
  return known(safe, "sourced", sourceId, locator);
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function finiteNumber(value: unknown, locator: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LmEvalIngestionError("invalid_metric", `${locator} must be a finite number.`);
  }
  return value;
}

function metricParts(sourceKey: string): { name: string; filter?: string; stderr: boolean } {
  const comma = sourceKey.indexOf(",");
  const metricPart = comma < 0 ? sourceKey : sourceKey.slice(0, comma);
  const filter = comma < 0 ? undefined : sourceKey.slice(comma + 1);
  if (metricPart === "" || filter === "") {
    throw new LmEvalIngestionError("invalid_metric_key", `Invalid lm-eval metric key “${sourceKey}”.`);
  }
  const stderr = metricPart.endsWith("_stderr");
  return {
    name: stderr ? metricPart.slice(0, -"_stderr".length) : metricPart,
    ...(filter === undefined ? {} : { filter }),
    stderr,
  };
}

function stderrKeyFor(sourceKey: string): string {
  const comma = sourceKey.indexOf(",");
  return comma < 0
    ? `${sourceKey}_stderr`
    : `${sourceKey.slice(0, comma)}_stderr${sourceKey.slice(comma)}`;
}

function parseMetrics(
  result: JsonObject,
  resultRoot: "results" | "groups",
  recordName: string,
  raw: JsonObject,
  sourceId: string,
  diagnostics: IngestionDiagnostic[],
): EvaluationMetric[] {
  const higherRoot = optionalObject(raw.higher_is_better);
  const higher = optionalObject(higherRoot?.[recordName]);
  const sampleCounts = optionalObject(result.sample_count);
  const nSamplesRoot = optionalObject(raw["n-samples"]);
  const nSamples = optionalObject(nSamplesRoot?.[recordName]);
  const effectiveSamples = safeInteger(nSamples?.effective);
  const sampleLength = safeInteger(result.sample_len);
  const stderrKeys = new Set(
    Object.keys(result).filter(
      (key) => !STRUCTURAL_RESULT_KEYS.has(key) && metricParts(key).stderr,
    ),
  );
  const metrics: EvaluationMetric[] = [];

  Object.keys(result)
    .sort()
    .forEach((sourceKey) => {
      if (STRUCTURAL_RESULT_KEYS.has(sourceKey)) return;
      const parts = metricParts(sourceKey);
      const locator = sourceLocator(resultRoot, recordName, sourceKey);
      if (parts.stderr) {
        return;
      }
      const value = finiteNumber(result[sourceKey], locator);
      const stderrKey = stderrKeyFor(sourceKey);
      const stderrLocator = sourceLocator(resultRoot, recordName, stderrKey);
      let standardError: EvaluationClaim<number>;
      if (hasOwn(result, stderrKey)) {
        const stderr = finiteNumber(result[stderrKey], stderrLocator);
        if (stderr < 0) {
          throw new LmEvalIngestionError("invalid_metric", `${stderrLocator} cannot be negative.`);
        }
        standardError = known(stderr, "measured", sourceId, stderrLocator);
        stderrKeys.delete(stderrKey);
      } else {
        standardError = unknown(
          `The raw artifact does not report standard error for ${sourceKey}.`,
          sourceId,
          stderrLocator,
        );
      }

      const higherValue = higher?.[sourceKey] ?? higher?.[parts.name];
      const higherClaim =
        typeof higherValue === "boolean"
          ? known(
              higherValue,
              "sourced",
              sourceId,
              sourceLocator("higher_is_better", recordName, parts.name),
            )
          : unknown<boolean>(
              `The raw artifact does not report whether ${parts.name} is higher-is-better.`,
              sourceId,
              sourceLocator("higher_is_better", recordName, parts.name),
            );

      const metricSampleCount = safeInteger(sampleCounts?.[sourceKey] ?? sampleCounts?.[parts.name]);
      const sampleCountValue = metricSampleCount ?? effectiveSamples ?? sampleLength;
      const sampleCount =
        sampleCountValue === undefined
          ? unknown<number>(
              `The raw artifact does not report sample count for ${sourceKey}.`,
              sourceId,
              sourceLocator("n-samples", recordName),
            )
          : known(
              sampleCountValue,
              "sourced",
              sourceId,
              metricSampleCount !== undefined
                ? sourceLocator(resultRoot, recordName, "sample_count", sourceKey)
                : effectiveSamples !== undefined
                  ? sourceLocator("n-samples", recordName, "effective")
                  : sourceLocator(resultRoot, recordName, "sample_len"),
            );

      metrics.push({
        sourceKey,
        name: parts.name,
        filter:
          parts.filter === undefined
            ? unknown(
                "Legacy metric keys do not declare an lm-eval filter.",
                sourceId,
                locator,
              )
            : known(parts.filter, "sourced", sourceId, locator),
        value: known(value, "measured", sourceId, locator),
        standardError,
        higherIsBetter: higherClaim,
        sampleCount,
      });
    });

  stderrKeys.forEach((key) => {
    diagnostic(
      diagnostics,
      "orphan_standard_error",
      `Standard-error field “${key}” has no matching metric and was not promoted to a score.`,
      sourceLocator(resultRoot, recordName, key),
    );
  });
  if (metrics.length === 0) {
    throw new LmEvalIngestionError(
      "no_metrics",
      `${sourceLocator(resultRoot, recordName)} contains no numeric metrics.`,
    );
  }
  return metrics.sort((left, right) =>
    `${left.name}\u0000${left.sourceKey}`.localeCompare(`${right.name}\u0000${right.sourceKey}`),
  );
}

function parseTask(
  taskName: string,
  result: JsonObject,
  raw: JsonObject,
  sourceId: string,
  diagnostics: IngestionDiagnostic[],
): EvaluationTaskResult {
  const versions = optionalObject(raw.versions);
  const configs = optionalObject(raw.configs);
  const config = optionalObject(configs?.[taskName]);
  const taskHashes = optionalObject(raw.task_hashes);
  const shots = optionalObject(raw["n-shot"]);
  const sampleRoot = optionalObject(raw["n-samples"]);
  const samples = optionalObject(sampleRoot?.[taskName]);

  const versionValue = versions?.[taskName];
  const version =
    typeof versionValue === "string" || typeof versionValue === "number"
      ? known(String(versionValue), "sourced", sourceId, sourceLocator("versions", taskName))
      : unknown<string>(
          "The raw artifact does not report a task version.",
          sourceId,
          sourceLocator("versions", taskName),
        );
  const datasetPath =
    typeof config?.dataset_path === "string" && config.dataset_path.trim() !== ""
      ? known(
          config.dataset_path,
          "sourced",
          sourceId,
          sourceLocator("configs", taskName, "dataset_path"),
        )
      : unknown<string>(
          "The raw artifact does not report a dataset path.",
          sourceId,
          sourceLocator("configs", taskName, "dataset_path"),
        );
  const datasetKwargs = optionalObject(config?.dataset_kwargs);
  const revisionValue = datasetKwargs?.revision ?? datasetKwargs?.dataset_revision;
  const datasetRevision =
    typeof revisionValue === "string" && revisionValue.trim() !== ""
      ? known(
          revisionValue,
          "sourced",
          sourceId,
          sourceLocator("configs", taskName, "dataset_kwargs", "revision"),
        )
      : unknown<string>(
          "The raw artifact does not report an immutable dataset revision.",
          sourceId,
          sourceLocator("configs", taskName, "dataset_kwargs", "revision"),
        );
  const taskHashValue = taskHashes?.[taskName];
  const taskHash =
    typeof taskHashValue === "string" && taskHashValue.trim() !== ""
      ? known(taskHashValue, "sourced", sourceId, sourceLocator("task_hashes", taskName))
      : unknown<string>(
          "The raw artifact does not report a task configuration hash.",
          sourceId,
          sourceLocator("task_hashes", taskName),
        );
  const shotValue = safeInteger(shots?.[taskName]);
  const fewShot =
    shotValue === undefined
      ? unknown<number>(
          "The raw artifact does not report the number of few-shot examples.",
          sourceId,
          sourceLocator("n-shot", taskName),
        )
      : known(shotValue, "sourced", sourceId, sourceLocator("n-shot", taskName));
  const originalValue = safeInteger(samples?.original);
  const effectiveValue = safeInteger(samples?.effective);
  if (
    originalValue !== undefined &&
    effectiveValue !== undefined &&
    effectiveValue > originalValue
  ) {
    throw new LmEvalIngestionError(
      "invalid_sample_count",
      `${sourceLocator("n-samples", taskName, "effective")} cannot exceed original samples.`,
    );
  }

  return {
    name: taskName,
    alias:
      typeof result.alias === "string" && result.alias.trim() !== ""
        ? known(result.alias, "sourced", sourceId, sourceLocator("results", taskName, "alias"))
        : unknown<string>(
            "The raw artifact does not report a task alias.",
            sourceId,
            sourceLocator("results", taskName, "alias"),
          ),
    version,
    datasetPath,
    datasetRevision,
    taskHash,
    fewShot,
    originalSamples:
      originalValue === undefined
        ? unknown<number>(
            "The raw artifact does not report the original sample count.",
            sourceId,
            sourceLocator("n-samples", taskName, "original"),
          )
        : known(
            originalValue,
            "sourced",
            sourceId,
            sourceLocator("n-samples", taskName, "original"),
          ),
    effectiveSamples:
      effectiveValue === undefined
        ? unknown<number>(
            "The raw artifact does not report the effective sample count.",
            sourceId,
            sourceLocator("n-samples", taskName, "effective"),
          )
        : known(
            effectiveValue,
            "sourced",
            sourceId,
            sourceLocator("n-samples", taskName, "effective"),
          ),
    metrics: parseMetrics(result, "results", taskName, raw, sourceId, diagnostics),
  };
}

function parseGroups(
  raw: JsonObject,
  sourceId: string,
  diagnostics: IngestionDiagnostic[],
): EvaluationGroupResult[] {
  const groups = optionalObject(raw.groups) ?? {};
  const subtasks = optionalObject(raw.group_subtasks);
  return Object.keys(groups)
    .sort()
    .map((groupName) => {
      const result = requiredObject(groups[groupName], sourceLocator("groups", groupName));
      const children = subtasks?.[groupName];
      const taskNames = Array.isArray(children)
        ? children.filter((entry): entry is string => typeof entry === "string").sort()
        : [];
      if (!Array.isArray(children)) {
        diagnostic(
          diagnostics,
          "group_subtasks_unknown",
          `Group “${groupName}” has no declared subtask list.`,
          sourceLocator("group_subtasks", groupName),
        );
      }
      return {
        name: groupName,
        taskNames,
        metrics: parseMetrics(result, "groups", groupName, raw, sourceId, diagnostics),
      };
    });
}

function validHashClaim(
  value: unknown,
  field: string,
  sourceId: string,
  diagnostics: IngestionDiagnostic[],
): EvaluationClaim<string | null> {
  const locator = sourceLocator(field);
  if (value === null) return known(null, "sourced", sourceId, locator);
  if (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)) {
    return known(value.toLowerCase(), "sourced", sourceId, locator);
  }
  if (value !== undefined) {
    diagnostic(
      diagnostics,
      "invalid_hash_dropped",
      `${field} was present but was not a 64-character SHA-256 digest.`,
      locator,
    );
  }
  return unknown(`${field} is not reported as a valid SHA-256 digest.`, sourceId, locator);
}

function normalizedExecutionDate(
  value: unknown,
  sourceId: string,
  diagnostics: IngestionDiagnostic[],
): EvaluationClaim<string> {
  const locator = sourceLocator("date");
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const milliseconds = value * 1000;
    if (Number.isFinite(milliseconds)) {
      try {
        return known(new Date(milliseconds).toISOString(), "calculated", sourceId, locator);
      } catch {
        // Fall through to an explicit unknown below.
      }
    }
  }
  if (value !== undefined) {
    diagnostic(
      diagnostics,
      "invalid_execution_date",
      "The evaluation date could not be normalized from Unix seconds.",
      locator,
    );
  }
  return unknown("The raw artifact does not report a valid execution date.", sourceId, locator);
}

function safeModelRepository(
  value: unknown,
  locator: string,
  diagnostics: IngestionDiagnostic[],
): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const candidate = value.trim();
  if (!CANONICAL_MODEL_REPOSITORY.test(candidate)) {
    diagnostic(
      diagnostics,
      "unsafe_model_repository_dropped",
      "A non-canonical model repository value was dropped instead of being copied verbatim.",
      locator,
    );
    return undefined;
  }
  return candidate;
}

function buildModelBinding(
  raw: JsonObject,
  source: LmEvalImportSourceMetadata,
  sourceId: string,
  modelArgs: Map<string, string | number | boolean | null>,
  diagnostics: IngestionDiagnostic[],
): EvaluationRun["model"] {
  const config = optionalObject(raw.config) ?? {};
  const modelNameRepository = safeModelRepository(
    raw.model_name,
    sourceLocator("model_name"),
    diagnostics,
  );
  const pretrainedRepository = safeModelRepository(
    modelArgs.get("pretrained"),
    sourceLocator("config", "model_args", "pretrained"),
    diagnostics,
  );
  const rawRepository = modelNameRepository ?? pretrainedRepository;
  const candidateRevision =
    typeof config.model_sha === "string" && /^[a-f0-9]{40}$/i.test(config.model_sha)
      ? config.model_sha.toLowerCase()
      : typeof config.model_revision === "string" && /^[a-f0-9]{40}$/i.test(config.model_revision)
        ? config.model_revision.toLowerCase()
        : typeof modelArgs.get("revision") === "string" &&
            /^[a-f0-9]{40}$/i.test(String(modelArgs.get("revision")))
          ? String(modelArgs.get("revision")).toLowerCase()
          : undefined;
  if (
    candidateRevision === undefined &&
    (config.model_revision === "main" || modelArgs.get("revision") === "main")
  ) {
    diagnostic(
      diagnostics,
      "mutable_model_revision",
      "A mutable model revision was not accepted as artifact identity.",
      sourceLocator("config", "model_revision"),
    );
  }

  const expected = source.expectedModelId ? findModel(source.expectedModelId) : undefined;
  if (source.expectedModelId && !expected) {
    diagnostic(
      diagnostics,
      "unknown_expected_model",
      `Expected model “${source.expectedModelId}” is not present in the exact artifact registry.`,
    );
  }
  let match = candidateRevision
    ? registry.models.find((model) => model.artifact.revision === candidateRevision)
    : undefined;
  if (expected && expected.artifact.revision !== candidateRevision) {
    diagnostic(
      diagnostics,
      "model_revision_mismatch",
      "The expected registry model does not match the raw artifact model SHA.",
      sourceLocator("config", "model_sha"),
    );
    match = undefined;
  } else if (expected) {
    match = expected;
  }
  if (
    match &&
    rawRepository &&
    rawRepository.toLowerCase() !== match.artifact.repository.toLowerCase()
  ) {
    diagnostic(
      diagnostics,
      "model_repository_mismatch",
      "The raw model repository conflicts with the registry artifact that matches its SHA.",
      sourceLocator("model_name"),
    );
    match = undefined;
  }

  return {
    registryModelId: match
      ? known(match.id, "sourced", sourceId, sourceLocator("config", "model_sha"))
      : unknown(
          "No exact registry artifact is proven by the raw model SHA.",
          sourceId,
          sourceLocator("config", "model_sha"),
        ),
    repository:
      match
        ? known(
            match.artifact.repository,
            "calculated",
            sourceId,
            sourceLocator("config", "model_sha"),
          )
        : rawRepository === undefined
          ? unknown(
              "The raw artifact does not report a model repository.",
              sourceId,
              sourceLocator("model_name"),
            )
          : known(rawRepository, "sourced", sourceId, sourceLocator("model_name")),
    revision:
      candidateRevision === undefined
        ? unknown(
            "The raw artifact does not report an immutable 40-character model revision.",
            sourceId,
            sourceLocator("config", "model_sha"),
          )
        : known(candidateRevision, "sourced", sourceId, sourceLocator("config", "model_sha")),
    binding: match ? "artifact_hash_match" : "unresolved",
  };
}

function buildExecution(
  raw: JsonObject,
  sourceId: string,
  modelArgs: Map<string, string | number | boolean | null>,
  diagnostics: IngestionDiagnostic[],
): EvaluationRun["execution"] {
  const config = optionalObject(raw.config) ?? {};
  const duration = raw.total_evaluation_time_seconds;
  const backend =
    typeof raw.model_source === "string" && raw.model_source.trim() !== ""
      ? raw.model_source.trim()
      : typeof config.model === "string" && config.model.trim() !== ""
        ? config.model.trim()
        : undefined;
  const dtype =
    typeof config.model_dtype === "string" && config.model_dtype.trim() !== ""
      ? config.model_dtype.trim()
      : typeof modelArgs.get("dtype") === "string" && String(modelArgs.get("dtype")).trim() !== ""
        ? String(modelArgs.get("dtype")).trim()
        : undefined;
  const quantizationValue = modelArgs.get("quantization");
  const quantization =
    typeof quantizationValue === "string" && quantizationValue.trim() !== ""
      ? quantizationValue.trim()
      : String(modelArgs.get("load_in_4bit")).toLowerCase() === "true"
        ? "4bit"
        : String(modelArgs.get("load_in_8bit")).toLowerCase() === "true"
          ? "8bit"
          : undefined;
  const seedValues = {
    random: safeInteger(config.random_seed),
    numpy: safeInteger(config.numpy_seed),
    torch: safeInteger(config.torch_seed),
    fewshot: safeInteger(config.fewshot_seed),
  };
  const seedsKnown = Object.values(seedValues).every((value) => value !== undefined);

  let limit: EvaluationClaim<number | null>;
  if (!hasOwn(config, "limit")) {
    limit = unknown("The raw artifact does not report an evaluation limit.", sourceId, sourceLocator("config", "limit"));
  } else if (config.limit === null) {
    limit = known(null, "sourced", sourceId, sourceLocator("config", "limit"));
  } else if (typeof config.limit === "number" && Number.isFinite(config.limit) && config.limit >= 0) {
    limit = known(config.limit, "sourced", sourceId, sourceLocator("config", "limit"));
  } else {
    throw new LmEvalIngestionError("invalid_limit", "$.config.limit must be null or a non-negative number.");
  }

  return {
    executedAt: normalizedExecutionDate(raw.date, sourceId, diagnostics),
    durationSeconds:
      (typeof duration === "string" && duration.trim() !== "") ||
      (typeof duration === "number" && Number.isFinite(duration) && duration >= 0)
        ? known(String(duration), "measured", sourceId, sourceLocator("total_evaluation_time_seconds"))
        : unknown(
            "The raw artifact does not report evaluation duration.",
            sourceId,
            sourceLocator("total_evaluation_time_seconds"),
          ),
    backend:
      backend === undefined
        ? unknown("The raw artifact does not report a model backend.", sourceId, sourceLocator("model_source"))
        : known(backend, "sourced", sourceId, sourceLocator("model_source")),
    runtimeVersion:
      typeof raw.transformers_version === "string" && raw.transformers_version.trim() !== ""
        ? known(
            raw.transformers_version,
            "sourced",
            sourceId,
            sourceLocator("transformers_version"),
          )
        : unknown(
            "The raw artifact does not report a runtime library version.",
            sourceId,
            sourceLocator("transformers_version"),
          ),
    device:
      typeof config.device === "string" && config.device.trim() !== ""
        ? known(config.device, "sourced", sourceId, sourceLocator("config", "device"))
        : unknown(
            "The raw artifact does not identify the execution device.",
            sourceId,
            sourceLocator("config", "device"),
          ),
    hardwareTopology: unknown(
      "lm-eval aggregated JSON does not provide a structured hardware topology in the supported fields.",
      sourceId,
      sourceLocator("pretty_env_info"),
    ),
    dtype:
      dtype === undefined
        ? unknown("The raw artifact does not report model dtype.", sourceId, sourceLocator("config", "model_dtype"))
        : known(dtype, "sourced", sourceId, sourceLocator("config", "model_dtype")),
    quantization:
      quantization === undefined
        ? unknown(
            "The raw artifact does not report a safely structured quantization setting.",
            sourceId,
            sourceLocator("config", "model_args", "quantization"),
          )
        : known(
            quantization,
            "sourced",
            sourceId,
            sourceLocator("config", "model_args", "quantization"),
          ),
    batchSize:
      (typeof config.batch_size === "string" && config.batch_size.trim() !== "") ||
      typeof config.batch_size === "number"
        ? known(String(config.batch_size).trim(), "sourced", sourceId, sourceLocator("config", "batch_size"))
        : unknown(
            "The raw artifact does not report batch size.",
            sourceId,
            sourceLocator("config", "batch_size"),
          ),
    limit,
    seeds: seedsKnown
      ? known(
          {
            random: seedValues.random as number,
            numpy: seedValues.numpy as number,
            torch: seedValues.torch as number,
            fewshot: seedValues.fewshot as number,
          },
          "sourced",
          sourceId,
          sourceLocator("config"),
        )
      : unknown(
          "The raw artifact does not report all four lm-eval seeds.",
          sourceId,
          sourceLocator("config"),
        ),
    chatTemplateSha256: validHashClaim(raw.chat_template_sha, "chat_template_sha", sourceId, diagnostics),
    systemInstructionSha256: validHashClaim(
      raw.system_instruction_sha,
      "system_instruction_sha",
      sourceId,
      diagnostics,
    ),
    generationConfig: safeGenerationConfig(config.gen_kwargs, sourceId, diagnostics),
  };
}

function sortDiagnostics(diagnostics: IngestionDiagnostic[]): IngestionDiagnostic[] {
  return diagnostics.sort((left, right) =>
    `${left.severity}\u0000${left.code}\u0000${left.locator ?? ""}\u0000${left.message}`.localeCompare(
      `${right.severity}\u0000${right.code}\u0000${right.locator ?? ""}\u0000${right.message}`,
    ),
  );
}

export function normalizeLmEvalArtifact(
  bytes: Uint8Array,
  importSource: LmEvalImportSourceMetadata,
): NormalizedLmEvalArtifact {
  validateImportSource(importSource);
  const decoded = decodeArtifact(bytes);
  const inspection = inspectParsed(decoded.parsed, decoded.sha256, bytes.byteLength);
  const raw = decoded.parsed;
  const diagnostics: IngestionDiagnostic[] = [];
  const sourceId = importSource.sourceId;
  const source: EvaluationSource = {
    id: sourceId,
    title: importSource.title,
    publisher: importSource.publisher,
    url: importSource.url,
    retrievedAt: importSource.retrievedAt,
    ...(importSource.publishedAt === undefined ? {} : { publishedAt: importSource.publishedAt }),
    ...(importSource.locator === undefined ? {} : { locator: importSource.locator }),
    ...(importSource.license === undefined ? {} : { license: importSource.license }),
    ...(importSource.licenseLocator === undefined
      ? {}
      : { licenseLocator: importSource.licenseLocator }),
    sourceType: "evaluation_artifact",
  };
  const runId = `lm-eval-sha256-${inspection.sha256}`;
  const rawArtifactId = `raw-lm-eval-sha256-${inspection.sha256}`;
  const rawArtifact: RawEvaluationArtifact = {
    id: rawArtifactId,
    runId,
    adapterId: INGEST_ADAPTER_ID,
    sourceId,
    kind: "lm_eval_results",
    mediaType: "application/json",
    uri: importSource.url,
    sha256: inspection.sha256,
    byteLength: inspection.bytes,
  };

  if (importSource.license === undefined) {
    diagnostic(
      diagnostics,
      "artifact_license_unknown",
      "The import metadata does not establish a license for the raw artifact.",
      importSource.licenseLocator ?? "license",
      "info",
    );
  }

  if (hasOwn(raw, "samples")) {
    diagnostic(
      diagnostics,
      "samples_not_ingested_v0_1",
      "Per-sample prompts, documents, targets, and responses are intentionally excluded from adapter v0.1.",
      sourceLocator("samples"),
      "info",
    );
  }
  if (hasOwn(raw, "pretty_env_info")) {
    diagnostic(
      diagnostics,
      "freeform_environment_not_copied",
      "Free-form environment text was not copied into normalized output.",
      sourceLocator("pretty_env_info"),
      "info",
    );
  }

  const config = optionalObject(raw.config) ?? {};
  const modelArgs = parseSafeModelArgs(config.model_args, diagnostics);
  const model = buildModelBinding(raw, importSource, sourceId, modelArgs, diagnostics);
  const results = requiredObject(raw.results, "$.results");
  const groupSet = new Set(inspection.groupNames);
  const tasks = Object.keys(results)
    .filter((taskName) => !groupSet.has(taskName))
    .sort()
    .map((taskName) =>
      parseTask(
        taskName,
        requiredObject(results[taskName], sourceLocator("results", taskName)),
        raw,
        sourceId,
        diagnostics,
      ),
    );
  const groups = parseGroups(raw, sourceId, diagnostics);

  const rawGitHash = raw.git_hash;
  const gitRevision =
    typeof rawGitHash === "string" && /^[a-f0-9]{7,40}$/i.test(rawGitHash)
      ? known(rawGitHash.toLowerCase(), "sourced", sourceId, sourceLocator("git_hash"))
      : unknown<string>(
          "The raw artifact does not report a valid lm-eval Git revision.",
          sourceId,
          sourceLocator("git_hash"),
        );
  if (rawGitHash !== undefined && gitRevision.status === "unknown") {
    diagnostic(
      diagnostics,
      "invalid_harness_revision",
      "The harness Git revision was present but not a 7–40 character hexadecimal revision.",
      sourceLocator("git_hash"),
    );
  }
  const revisionCompleteness: EvaluationRun["harness"]["revisionCompleteness"] =
    gitRevision.status === "unknown"
      ? "unknown"
      : gitRevision.value.length === 40
        ? "full"
        : "abbreviated";
  const harnessVersion =
    typeof raw.lm_eval_version === "string" && raw.lm_eval_version.trim() !== ""
      ? known(raw.lm_eval_version, "sourced", sourceId, sourceLocator("lm_eval_version"))
      : unknown<string>(
          "The raw artifact does not report an lm-eval package version.",
          sourceId,
          sourceLocator("lm_eval_version"),
        );

  const partialRun = {
    id: runId,
    adapter: {
      name: "lm-eval" as const,
      version: ADAPTER_VERSION,
      inputFamily: inspection.inputFamily,
    },
    rawArtifactIds: [rawArtifactId],
    model,
    harness: {
      name: "lm-evaluation-harness" as const,
      version: harnessVersion,
      gitRevision,
      revisionCompleteness,
    },
    execution: buildExecution(raw, sourceId, modelArgs, diagnostics),
    tasks,
    groups,
    diagnostics: sortDiagnostics(diagnostics),
  } satisfies Omit<EvaluationRun, "publicationStatus" | "eligibility">;
  const missing = evaluationRunEligibilityMissing(partialRun as EvaluationRun);
  const eligible = missing.length === 0;
  const run: EvaluationRun = {
    ...partialRun,
    publicationStatus: importSource.fixture ? "fixture_only" : eligible ? "eligible" : "incomplete",
    eligibility: { status: eligible ? "eligible" : "insufficient", missing },
  };
  const normalized: NormalizedLmEvalArtifact = {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    kind: "lm_eval_import",
    source,
    rawArtifact,
    run,
  };
  const validation = validateNormalizedLmEvalArtifact(normalized);
  if (!validation.valid) {
    throw new LmEvalIngestionError(
      "invalid_normalized_import",
      `The normalized staging envelope failed validation: ${validation.issues.join("; ")}`,
    );
  }
  return normalized;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    const output: Record<string, unknown> = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        output[key] = canonicalize(value[key]);
      });
    return output;
  }
  return value;
}

function exactObjectKeysForImport(
  value: JsonObject,
  required: readonly string[],
  path: string,
  issues: string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  required.forEach((key) => {
    if (!hasOwn(value, key)) issues.push(`${path}.${key}: missing property`);
  });
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) issues.push(`${path}.${key}: unexpected property`);
  });
}

function collectProvenanceSourceIds(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectProvenanceSourceIds(entry, output));
    return;
  }
  if (!isObject(value)) return;
  if (Array.isArray(value.provenance)) {
    value.provenance.forEach((entry) => {
      if (isObject(entry) && typeof entry.sourceId === "string") output.add(entry.sourceId);
    });
  }
  Object.values(value).forEach((entry) => collectProvenanceSourceIds(entry, output));
}

export function validateNormalizedLmEvalArtifact(
  input: unknown,
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!isObject(input)) return { valid: false, issues: ["$: expected object"] };
  exactObjectKeysForImport(
    input,
    ["schemaVersion", "kind", "source", "rawArtifact", "run"],
    "$",
    issues,
  );
  if (input.schemaVersion !== IMPORT_SCHEMA_VERSION) {
    issues.push(`$.schemaVersion: expected ${IMPORT_SCHEMA_VERSION}`);
  }
  if (input.kind !== "lm_eval_import") issues.push("$.kind: expected lm_eval_import");

  const source = isObject(input.source) ? input.source : undefined;
  if (!source) {
    issues.push("$.source: expected object");
  } else {
    exactObjectKeysForImport(
      source,
      ["id", "title", "publisher", "url", "retrievedAt", "sourceType"],
      "$.source",
      issues,
      ["publishedAt", "locator", "license", "licenseLocator"],
    );
    if (source.sourceType !== "evaluation_artifact") {
      issues.push("$.source.sourceType: expected evaluation_artifact");
    }
    if (
      typeof source.id === "string" &&
      typeof source.title === "string" &&
      typeof source.publisher === "string" &&
      typeof source.url === "string" &&
      typeof source.retrievedAt === "string"
    ) {
      try {
        validateImportSource({
          sourceId: source.id,
          title: source.title,
          publisher: source.publisher,
          url: source.url,
          retrievedAt: source.retrievedAt,
          ...(typeof source.publishedAt === "string"
            ? { publishedAt: source.publishedAt }
            : {}),
          ...(typeof source.locator === "string" ? { locator: source.locator } : {}),
          ...(typeof source.license === "string" ? { license: source.license } : {}),
          ...(typeof source.licenseLocator === "string"
            ? { licenseLocator: source.licenseLocator }
            : {}),
        });
      } catch (error) {
        issues.push(
          `$.source: ${error instanceof Error ? error.message : "invalid source metadata"}`,
        );
      }
    } else {
      issues.push("$.source: expected string identity and retrieval fields");
    }
    if (source.publishedAt !== undefined && typeof source.publishedAt !== "string") {
      issues.push("$.source.publishedAt: expected YYYY-MM-DD string");
    }
    for (const key of ["locator", "license", "licenseLocator"] as const) {
      if (source[key] !== undefined && (typeof source[key] !== "string" || source[key].trim() === "")) {
        issues.push(`$.source.${key}: expected non-empty string`);
      }
    }
  }

  const rawArtifact = isObject(input.rawArtifact) ? input.rawArtifact : undefined;
  if (!rawArtifact) {
    issues.push("$.rawArtifact: expected object");
  } else {
    exactObjectKeysForImport(
      rawArtifact,
      ["id", "runId", "adapterId", "sourceId", "kind", "mediaType", "uri", "sha256", "byteLength"],
      "$.rawArtifact",
      issues,
    );
    if (rawArtifact.adapterId !== INGEST_ADAPTER_ID) {
      issues.push(`$.rawArtifact.adapterId: expected ${INGEST_ADAPTER_ID}`);
    }
    if (source && rawArtifact.sourceId !== source.id) {
      issues.push("$.rawArtifact.sourceId: must match the staging source id");
    }
    if (rawArtifact.kind !== "lm_eval_results") {
      issues.push("$.rawArtifact.kind: expected lm_eval_results");
    }
    if (rawArtifact.mediaType !== "application/json") {
      issues.push("$.rawArtifact.mediaType: expected application/json");
    }
    if (typeof rawArtifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(rawArtifact.sha256)) {
      issues.push("$.rawArtifact.sha256: expected full lowercase SHA-256");
    }
    if (
      typeof rawArtifact.byteLength !== "number" ||
      !Number.isSafeInteger(rawArtifact.byteLength) ||
      rawArtifact.byteLength <= 0 ||
      rawArtifact.byteLength > MAX_LM_EVAL_ARTIFACT_BYTES
    ) {
      issues.push("$.rawArtifact.byteLength: expected supported positive byte length");
    }
  }

  const runValidation = validateEvaluationRun(input.run, registry);
  issues.push(...runValidation.issues.map((issue) => `$.run${issue.slice(1)}`));
  const run = isObject(input.run) ? input.run : undefined;
  if (source && rawArtifact && run) {
    if (rawArtifact.uri !== source.url) {
      issues.push("$.rawArtifact.uri: must match the staging source URL");
    }
    if (rawArtifact.runId !== run.id) {
      issues.push("$.rawArtifact.runId: must match the normalized run id");
    }
    if (typeof rawArtifact.sha256 === "string") {
      if (run.id !== `lm-eval-sha256-${rawArtifact.sha256}`) {
        issues.push("$.run.id: must be derived from the raw artifact SHA-256");
      }
      if (rawArtifact.id !== `raw-lm-eval-sha256-${rawArtifact.sha256}`) {
        issues.push("$.rawArtifact.id: must be derived from its SHA-256");
      }
    }
    if (
      !Array.isArray(run.rawArtifactIds) ||
      run.rawArtifactIds.length !== 1 ||
      run.rawArtifactIds[0] !== rawArtifact.id
    ) {
      issues.push("$.run.rawArtifactIds: must contain only the staged raw artifact id");
    }
    if (typeof source.id === "string") {
      const referencedSourceIds = new Set<string>();
      collectProvenanceSourceIds(run, referencedSourceIds);
      referencedSourceIds.forEach((sourceId) => {
        if (sourceId !== source.id) {
          issues.push(`$.run: provenance references unknown source ${sourceId}`);
        }
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

export function parseNormalizedLmEvalArtifact(input: unknown): NormalizedLmEvalArtifact {
  const result = validateNormalizedLmEvalArtifact(input);
  if (!result.valid) {
    throw new LmEvalIngestionError(
      "invalid_normalized_import",
      `Normalized staging envelope validation failed: ${result.issues.join("; ")}`,
    );
  }
  return input as NormalizedLmEvalArtifact;
}

export function serializeNormalizedLmEvalArtifact(value: NormalizedLmEvalArtifact): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}
