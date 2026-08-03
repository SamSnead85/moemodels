import { canonicalSha256Hex, canonicalizeJson, sha256Hex } from "./canonical.js";
import {
  EVIDENCE_PASSPORT_CANONICALIZATION,
  EVIDENCE_PASSPORT_KIND,
  EVIDENCE_PASSPORT_REQUIRED_TRIALS,
  EVIDENCE_PASSPORT_SCHEMA_VERSION,
  EVIDENCE_PASSPORT_SIGNATURE_SEMANTICS,
  type DeployBenchEvidencePassport,
  type EvidencePassportSignature,
  type EvidencePassportSignatureVerification,
  type EvidencePassportVerification,
  type ReproducibilityAssessment,
  type ReproducibilityGate,
} from "./passport-types.js";
import { summarizeRequestMeasurements } from "./summary.js";
import {
  ENDPOINT_BENCHMARK_ADMISSION_NOTICE,
  type DistributionSummary,
  type EndpointBenchmarkResult,
  type RequestMeasurement,
} from "./types.js";

type JsonObject = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/;
const PASSPORT_ID = /^deploybench-passport-sha256-([a-f0-9]{64})$/;
const RUN_ID = /^endpoint-sha256-[a-f0-9]{64}$/;
const IMMUTABLE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SIGNATURE_DOMAIN = "MOEMODELS_DEPLOYBENCH_PASSPORT_V0_2\n";
const textEncoder = new TextEncoder();

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: JsonObject,
  required: readonly string[],
  path: string,
  issues: string[],
): void {
  const requiredSet = new Set(required);
  for (const key of required) {
    if (!(key in value)) issues.push(`${path}.${key}: missing property`);
  }
  for (const key of Object.keys(value)) {
    if (!requiredSet.has(key)) issues.push(`${path}.${key}: unexpected property`);
  }
}

function objectAt(value: unknown, path: string, issues: string[]): JsonObject {
  if (!isObject(value)) {
    issues.push(`${path}: expected object`);
    return {};
  }
  return value;
}

function arrayAt(value: unknown, path: string, issues: string[]): unknown[] {
  if (!Array.isArray(value)) {
    issues.push(`${path}: expected array`);
    return [];
  }
  return value;
}

function stringAt(value: unknown, path: string, issues: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path}: expected non-empty string`);
    return "";
  }
  return value;
}

function nullableStringAt(
  value: unknown,
  path: string,
  issues: string[],
): string | null {
  if (value === null) return null;
  return stringAt(value, path, issues);
}

function finiteNumberAt(value: unknown, path: string, issues: string[]): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${path}: expected finite number`);
    return 0;
  }
  return value;
}

function nonNegativeNumberAt(value: unknown, path: string, issues: string[]): number {
  const parsed = finiteNumberAt(value, path, issues);
  if (parsed < 0) issues.push(`${path}: expected non-negative number`);
  return parsed;
}

function integerAt(
  value: unknown,
  path: string,
  issues: string[],
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    issues.push(`${path}: expected safe integer >= ${minimum}`);
    return minimum;
  }
  return Number(value);
}

function nullableIntegerAt(
  value: unknown,
  path: string,
  issues: string[],
): number | null {
  if (value === null) return null;
  return integerAt(value, path, issues);
}

function dateTimeAt(value: unknown, path: string, issues: string[]): number | null {
  const text = stringAt(value, path, issues);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    issues.push(`${path}: expected RFC 3339 timestamp`);
    return null;
  }
  try {
    if (new Date(timestamp).toISOString() !== text) {
      issues.push(`${path}: expected canonical UTC timestamp`);
    }
  } catch {
    issues.push(`${path}: expected valid timestamp`);
  }
  return timestamp;
}

function distributionAt(
  value: unknown,
  path: string,
  issues: string[],
): DistributionSummary | null {
  if (value === null) return null;
  const item = objectAt(value, path, issues);
  exactKeys(item, ["minimum", "p50", "p95", "p99", "maximum", "mean"], path, issues);
  const result = {
    minimum: nonNegativeNumberAt(item.minimum, `${path}.minimum`, issues),
    p50: nonNegativeNumberAt(item.p50, `${path}.p50`, issues),
    p95: nonNegativeNumberAt(item.p95, `${path}.p95`, issues),
    p99: nonNegativeNumberAt(item.p99, `${path}.p99`, issues),
    maximum: nonNegativeNumberAt(item.maximum, `${path}.maximum`, issues),
    mean: nonNegativeNumberAt(item.mean, `${path}.mean`, issues),
  };
  if (
    result.minimum > result.p50 ||
    result.p50 > result.p95 ||
    result.p95 > result.p99 ||
    result.p99 > result.maximum
  ) {
    issues.push(`${path}: percentiles must be monotonically non-decreasing`);
  }
  return result;
}

function measurementAt(
  value: unknown,
  path: string,
  issues: string[],
): RequestMeasurement {
  const item = objectAt(value, path, issues);
  exactKeys(
    item,
    [
      "requestIndex",
      "status",
      "httpStatus",
      "ttftMs",
      "totalLatencyMs",
      "promptTokens",
      "outputTokens",
      "outputCharacters",
      "errorCode",
    ],
    path,
    issues,
  );
  const requestIndex = integerAt(item.requestIndex, `${path}.requestIndex`, issues);
  const status = item.status;
  if (status !== "succeeded" && status !== "failed") {
    issues.push(`${path}.status: expected succeeded or failed`);
  }
  const httpStatus = nullableIntegerAt(item.httpStatus, `${path}.httpStatus`, issues);
  const ttftMs = item.ttftMs === null
    ? null
    : nonNegativeNumberAt(item.ttftMs, `${path}.ttftMs`, issues);
  const totalLatencyMs = nonNegativeNumberAt(
    item.totalLatencyMs,
    `${path}.totalLatencyMs`,
    issues,
  );
  const promptTokens = nullableIntegerAt(item.promptTokens, `${path}.promptTokens`, issues);
  const outputTokens = nullableIntegerAt(item.outputTokens, `${path}.outputTokens`, issues);
  const outputCharacters = integerAt(
    item.outputCharacters,
    `${path}.outputCharacters`,
    issues,
  );
  const errorCode = nullableStringAt(item.errorCode, `${path}.errorCode`, issues);

  if (status === "succeeded") {
    if (httpStatus === null || httpStatus < 200 || httpStatus > 299) {
      issues.push(`${path}.httpStatus: successful requests require a 2xx status`);
    }
    if (errorCode !== null) issues.push(`${path}.errorCode: successful requests require null`);
  }
  if (status === "failed") {
    if (ttftMs !== null) issues.push(`${path}.ttftMs: failed requests require null`);
    if (errorCode === null) issues.push(`${path}.errorCode: failed requests require a code`);
  }

  return {
    requestIndex,
    status: status === "succeeded" ? "succeeded" : "failed",
    httpStatus,
    ttftMs,
    totalLatencyMs,
    promptTokens,
    outputTokens,
    outputCharacters,
    errorCode,
  };
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJson(left) === canonicalizeJson(right);
  } catch {
    return false;
  }
}

export function validateEndpointBenchmarkResult(
  input: unknown,
): {
  valid: boolean;
  schemaValid: boolean;
  issues: string[];
  structuralIssues: string[];
  semanticIssues: string[];
} {
  const structuralIssues: string[] = [];
  const semanticIssues: string[] = [];
  const issues = structuralIssues;
  const root = objectAt(input, "$", issues);
  exactKeys(
    root,
    [
      "schemaVersion",
      "kind",
      "classification",
      "run",
      "workload",
      "summary",
      "measurements",
      "missingContext",
      "privacy",
    ],
    "$",
    issues,
  );
  if (root.schemaVersion !== "0.1.0") issues.push("$.schemaVersion: expected 0.1.0");
  if (root.kind !== "moemodels_endpoint_benchmark") {
    issues.push("$.kind: expected moemodels_endpoint_benchmark");
  }

  const classification = objectAt(root.classification, "$.classification", issues);
  exactKeys(classification, ["evidenceClass", "comparisonEligible", "reason"], "$.classification", issues);
  if (classification.evidenceClass !== "measured") {
    issues.push("$.classification.evidenceClass: expected measured");
  }
  if (classification.comparisonEligible !== false) {
    issues.push("$.classification.comparisonEligible: endpoint trials must remain false");
  }
  stringAt(classification.reason, "$.classification.reason", issues);

  const run = objectAt(root.run, "$.run", issues);
  exactKeys(
    run,
    ["id", "startedAt", "completedAt", "endpointOrigin", "model", "artifact", "runtime", "infrastructure"],
    "$.run",
    issues,
  );
  const runId = stringAt(run.id, "$.run.id", issues);
  if (!RUN_ID.test(runId)) issues.push("$.run.id: expected endpoint-sha256 content-shaped id");
  const startedAt = dateTimeAt(run.startedAt, "$.run.startedAt", issues);
  const completedAt = dateTimeAt(run.completedAt, "$.run.completedAt", issues);
  if (startedAt !== null && completedAt !== null && completedAt < startedAt) {
    semanticIssues.push("$.run.completedAt: cannot precede startedAt");
  }
  const endpointOrigin = stringAt(run.endpointOrigin, "$.run.endpointOrigin", issues);
  try {
    const parsed = new URL(endpointOrigin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== endpointOrigin) {
      issues.push("$.run.endpointOrigin: expected normalized http(s) origin");
    }
    if (parsed.username || parsed.password) {
      issues.push("$.run.endpointOrigin: credentials are prohibited");
    }
  } catch {
    issues.push("$.run.endpointOrigin: expected valid URL origin");
  }
  stringAt(run.model, "$.run.model", issues);

  const artifact = objectAt(run.artifact, "$.run.artifact", issues);
  exactKeys(artifact, ["binding", "repository", "revision"], "$.run.artifact", issues);
  if (artifact.binding !== "exact_revision" && artifact.binding !== "endpoint_model_name_only") {
    issues.push("$.run.artifact.binding: invalid binding");
  }
  const repository = nullableStringAt(artifact.repository, "$.run.artifact.repository", issues);
  const revision = nullableStringAt(artifact.revision, "$.run.artifact.revision", issues);
  if ((repository === null) !== (revision === null)) {
    semanticIssues.push("$.run.artifact: repository and revision must be supplied together");
  }
  if (artifact.binding === "exact_revision" && (repository === null || revision === null)) {
    semanticIssues.push("$.run.artifact.binding: exact_revision requires repository and revision");
  }
  if (artifact.binding === "endpoint_model_name_only" && (repository !== null || revision !== null)) {
    semanticIssues.push("$.run.artifact.binding: endpoint_model_name_only requires null identity fields");
  }

  const runtime = objectAt(run.runtime, "$.run.runtime", issues);
  exactKeys(runtime, ["name", "version"], "$.run.runtime", issues);
  nullableStringAt(runtime.name, "$.run.runtime.name", issues);
  nullableStringAt(runtime.version, "$.run.runtime.version", issues);

  const infrastructure = objectAt(run.infrastructure, "$.run.infrastructure", issues);
  exactKeys(infrastructure, ["hardware", "topology"], "$.run.infrastructure", issues);
  nullableStringAt(infrastructure.hardware, "$.run.infrastructure.hardware", issues);
  nullableStringAt(infrastructure.topology, "$.run.infrastructure.topology", issues);

  const workload = objectAt(root.workload, "$.workload", issues);
  exactKeys(
    workload,
    [
      "protocol",
      "promptSha256",
      "promptUtf8Bytes",
      "maxOutputTokens",
      "requests",
      "concurrency",
      "warmupRequests",
      "temperature",
    ],
    "$.workload",
    issues,
  );
  if (workload.protocol !== "openai_chat_completions_stream") {
    issues.push("$.workload.protocol: expected openai_chat_completions_stream");
  }
  const promptSha256 = stringAt(workload.promptSha256, "$.workload.promptSha256", issues);
  if (!SHA256.test(promptSha256)) issues.push("$.workload.promptSha256: expected lowercase SHA-256");
  integerAt(workload.promptUtf8Bytes, "$.workload.promptUtf8Bytes", issues, 1);
  integerAt(workload.maxOutputTokens, "$.workload.maxOutputTokens", issues, 1);
  const requestedRequests = integerAt(workload.requests, "$.workload.requests", issues, 1);
  const concurrency = integerAt(workload.concurrency, "$.workload.concurrency", issues, 1);
  if (concurrency > requestedRequests) {
    semanticIssues.push("$.workload.concurrency: cannot exceed requests");
  }
  integerAt(workload.warmupRequests, "$.workload.warmupRequests", issues);
  if (workload.temperature !== 0) issues.push("$.workload.temperature: expected deterministic zero");

  const summary = objectAt(root.summary, "$.summary", issues);
  exactKeys(
    summary,
    [
      "attemptedRequests",
      "successfulRequests",
      "failedRequests",
      "wallTimeMs",
      "requestThroughputPerSecond",
      "outputTokenThroughputPerSecond",
      "ttftMs",
      "totalLatencyMs",
    ],
    "$.summary",
    issues,
  );
  const attemptedRequests = integerAt(summary.attemptedRequests, "$.summary.attemptedRequests", issues, 1);
  const successfulRequests = integerAt(summary.successfulRequests, "$.summary.successfulRequests", issues);
  const failedRequests = integerAt(summary.failedRequests, "$.summary.failedRequests", issues);
  const wallTimeMs = finiteNumberAt(summary.wallTimeMs, "$.summary.wallTimeMs", issues);
  if (wallTimeMs <= 0) issues.push("$.summary.wallTimeMs: expected positive duration");
  nonNegativeNumberAt(summary.requestThroughputPerSecond, "$.summary.requestThroughputPerSecond", issues);
  if (summary.outputTokenThroughputPerSecond !== null) {
    nonNegativeNumberAt(
      summary.outputTokenThroughputPerSecond,
      "$.summary.outputTokenThroughputPerSecond",
      issues,
    );
  }
  distributionAt(summary.ttftMs, "$.summary.ttftMs", issues);
  distributionAt(summary.totalLatencyMs, "$.summary.totalLatencyMs", issues);
  if (successfulRequests + failedRequests !== attemptedRequests) {
    semanticIssues.push("$.summary: successfulRequests + failedRequests must equal attemptedRequests");
  }

  const measurementValues = arrayAt(root.measurements, "$.measurements", issues);
  const measurements = measurementValues.map((measurement, index) =>
    measurementAt(measurement, `$.measurements[${index}]`, issues),
  );
  const indexes = measurements.map((measurement) => measurement.requestIndex);
  if (new Set(indexes).size !== indexes.length) {
    semanticIssues.push("$.measurements: requestIndex values must be unique");
  }
  const expectedIndexes = Array.from({ length: measurements.length }, (_, index) => index);
  if (!canonicalEqual([...indexes].sort((left, right) => left - right), expectedIndexes)) {
    semanticIssues.push("$.measurements: requestIndex values must form a zero-based contiguous sequence");
  }
  if (measurements.length !== requestedRequests) {
    semanticIssues.push("$.measurements: count must equal workload.requests");
  }
  if (attemptedRequests !== measurements.length) {
    semanticIssues.push("$.summary.attemptedRequests: must equal measurements length");
  }
  if (wallTimeMs > 0) {
    const recomputed = summarizeRequestMeasurements(measurements, wallTimeMs);
    if (!canonicalEqual(recomputed, summary)) {
      semanticIssues.push("$.summary: values do not recompute from request measurements");
    }
  }

  const missingContext = arrayAt(root.missingContext, "$.missingContext", issues);
  const normalizedMissing = missingContext.map((entry, index) =>
    stringAt(entry, `$.missingContext[${index}]`, issues),
  );
  if (new Set(normalizedMissing).size !== normalizedMissing.length) {
    issues.push("$.missingContext: entries must be unique");
  }

  const privacy = objectAt(root.privacy, "$.privacy", issues);
  exactKeys(privacy, ["promptStored", "responseTextStored", "apiKeyStored", "statement"], "$.privacy", issues);
  for (const key of ["promptStored", "responseTextStored", "apiKeyStored"] as const) {
    if (privacy[key] !== false) issues.push(`$.privacy.${key}: expected false`);
  }
  stringAt(privacy.statement, "$.privacy.statement", issues);

  const uniqueStructuralIssues = [...new Set(structuralIssues)].sort();
  const uniqueSemanticIssues = [...new Set(semanticIssues)].sort();
  const combinedIssues = [...new Set([...uniqueStructuralIssues, ...uniqueSemanticIssues])].sort();
  return {
    valid: combinedIssues.length === 0,
    schemaValid: uniqueStructuralIssues.length === 0,
    issues: combinedIssues,
    structuralIssues: uniqueStructuralIssues,
    semanticIssues: uniqueSemanticIssues,
  };
}

export function endpointBenchmarkConfiguration(trial: EndpointBenchmarkResult) {
  return {
    endpointOrigin: trial.run.endpointOrigin,
    model: trial.run.model,
    artifact: trial.run.artifact,
    runtime: trial.run.runtime,
    infrastructure: trial.run.infrastructure,
    workload: trial.workload,
  };
}

function trialReference(indexes: readonly number[]): string {
  const numbers = indexes.map((index) => index + 1).join(", ");
  return `${indexes.length === 1 ? "trial" : "trials"} ${numbers}`;
}

function measurementContextIssues(
  trials: readonly EndpointBenchmarkResult[],
): string[] {
  const countGaps: number[] = [];
  const successGaps: number[] = [];
  const ttftGaps: number[] = [];
  const usageGaps: number[] = [];
  const materialContext: string[] = [];

  trials.forEach((trial, index) => {
    if (
      trial.measurements.length !== trial.workload.requests ||
      trial.summary.attemptedRequests !== trial.measurements.length
    ) {
      countGaps.push(index);
    }

    const successful = trial.measurements.filter(
      (measurement) => measurement.status === "succeeded",
    );
    if (successful.length === 0) {
      successGaps.push(index);
    } else {
      if (
        successful.some((measurement) => measurement.ttftMs === null) ||
        trial.summary.ttftMs === null
      ) {
        ttftGaps.push(index);
      }
      if (
        successful.some(
          (measurement) =>
            measurement.promptTokens === null || measurement.outputTokens === null,
        ) ||
        trial.summary.outputTokenThroughputPerSecond === null
      ) {
        usageGaps.push(index);
      }
    }

    trial.missingContext
      .filter((entry) => entry !== ENDPOINT_BENCHMARK_ADMISSION_NOTICE)
      .forEach((entry) => materialContext.push(`trial ${index + 1} — ${entry}`));
  });

  return [
    ...(countGaps.length > 0
      ? [`Measurement counts do not reconcile for ${trialReference(countGaps)}.`]
      : []),
    ...(successGaps.length > 0
      ? [`No successful request is available for ${trialReference(successGaps)}.`]
      : []),
    ...(ttftGaps.length > 0
      ? [`Successful-request TTFT is incomplete for ${trialReference(ttftGaps)}.`]
      : []),
    ...(usageGaps.length > 0
      ? [
          `Returned token usage or output-token throughput is incomplete for ${trialReference(usageGaps)}.`,
        ]
      : []),
    ...(materialContext.length > 0
      ? [`Material missing context remains: ${[...new Set(materialContext)].join(" | ")}`]
      : []),
  ];
}

export function assessEvidencePassportTrials(
  trials: readonly EndpointBenchmarkResult[],
  compatibleTrials = trials.length > 0 && trials.every((trial) =>
    canonicalEqual(endpointBenchmarkConfiguration(trial), endpointBenchmarkConfiguration(trials[0] as EndpointBenchmarkResult)),
  ),
): ReproducibilityAssessment {
  const first = trials[0];
  const artifactComplete = trials.length > 0 && trials.every((trial) =>
    trial.run.artifact.binding === "exact_revision" &&
    trial.run.artifact.repository !== null &&
    trial.run.artifact.revision !== null &&
    IMMUTABLE_REVISION.test(trial.run.artifact.revision),
  );
  const runtimeComplete = trials.length > 0 && trials.every((trial) =>
    trial.run.runtime.name !== null && trial.run.runtime.version !== null,
  );
  const infrastructureComplete = trials.length > 0 && trials.every((trial) =>
    trial.run.infrastructure.hardware !== null && trial.run.infrastructure.topology !== null,
  );
  const measurementIssues = measurementContextIssues(trials);
  const measurementsComplete = trials.length > 0 && measurementIssues.length === 0;
  const privacyComplete = trials.length > 0 && trials.every((trial) =>
    trial.privacy.promptStored === false &&
    trial.privacy.responseTextStored === false &&
    trial.privacy.apiKeyStored === false,
  );
  const gates: ReproducibilityGate[] = [
    {
      id: "compatible_trials",
      passed: compatibleTrials,
      detail: compatibleTrials
        ? "All trials share the same endpoint, model, artifact, runtime, infrastructure, and workload configuration."
        : "Every packed trial must share an identical configuration.",
    },
    {
      id: "minimum_trials",
      passed: trials.length >= EVIDENCE_PASSPORT_REQUIRED_TRIALS,
      detail: `${trials.length} observed; ${EVIDENCE_PASSPORT_REQUIRED_TRIALS} required for the v0.2 reproducibility gate.`,
    },
    {
      id: "immutable_artifact_revision",
      passed: artifactComplete,
      detail: artifactComplete
        ? `Artifact revision ${first?.run.artifact.revision ?? ""} is declared with an immutable-length digest.`
        : "Every trial must declare the same repository and 40- or 64-character revision.",
    },
    {
      id: "runtime_identity",
      passed: runtimeComplete,
      detail: runtimeComplete
        ? "Runtime name and exact version are declared."
        : "Runtime name and version are required in every trial.",
    },
    {
      id: "infrastructure_identity",
      passed: infrastructureComplete,
      detail: infrastructureComplete
        ? "Hardware and topology are declared."
        : "Hardware and topology are required in every trial.",
    },
    {
      id: "request_measurements",
      passed: measurementsComplete,
      detail: measurementsComplete
        ? "Each requested measurement is retained; successful requests include TTFT and returned token usage; no material context gap is declared."
        : measurementIssues.length > 0
          ? measurementIssues.join(" ")
          : "At least one trial is required before request measurements can be complete.",
    },
    {
      id: "privacy_boundary",
      passed: privacyComplete,
      detail: privacyComplete
        ? "Prompt text, response text, and API keys are declared absent."
        : "Every trial must preserve the default-deny content boundary.",
    },
  ];
  return {
    requiredTrials: EVIDENCE_PASSPORT_REQUIRED_TRIALS,
    observedTrials: trials.length,
    complete: gates.every((gate) => gate.passed),
    gates,
    missing: gates.filter((gate) => !gate.passed).map((gate) => gate.id),
  };
}

export function passportSignatureMessage(payloadSha256: string): Uint8Array {
  return textEncoder.encode(`${SIGNATURE_DOMAIN}${payloadSha256}`);
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new TypeError("Expected canonical base64.");
  }
  const decoded = globalThis.atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function verifySignature(
  signature: EvidencePassportSignature,
  payloadSha256: string,
): Promise<EvidencePassportSignatureVerification> {
  const invalid = (issue: string): EvidencePassportSignatureVerification => ({
    keyId: signature.keyId,
    status: "invalid",
    authorshipOnly: true,
    trusted: false,
    issue,
  });
  try {
    if (signature.signedPayloadSha256 !== payloadSha256) {
      return invalid("The signature references another payload digest.");
    }
    const publicKeyBytes = decodeBase64(signature.publicKeySpkiBase64);
    const expectedKeyId = `ed25519-sha256-${await sha256Hex(publicKeyBytes)}`;
    if (signature.keyId !== expectedKeyId) {
      return invalid("The key id does not match the embedded public key.");
    }
    const key = await globalThis.crypto.subtle.importKey(
      "spki",
      publicKeyBytes as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const verified = await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      decodeBase64(signature.signatureBase64) as BufferSource,
      passportSignatureMessage(payloadSha256) as BufferSource,
    );
    return verified
      ? {
          keyId: signature.keyId,
          status: "valid_self_signed",
          authorshipOnly: true,
          trusted: false,
          issue: null,
        }
      : invalid("The Ed25519 signature is invalid.");
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Signature verification failed.");
  }
}

function validateSignatureShape(
  value: unknown,
  path: string,
  issues: string[],
): EvidencePassportSignature | null {
  const item = objectAt(value, path, issues);
  exactKeys(
    item,
    [
      "kind",
      "algorithm",
      "keyId",
      "publicKeySpkiBase64",
      "signedPayloadSha256",
      "signatureBase64",
      "semantics",
    ],
    path,
    issues,
  );
  if (item.kind !== "operator_authorship") issues.push(`${path}.kind: expected operator_authorship`);
  if (item.algorithm !== "Ed25519") issues.push(`${path}.algorithm: expected Ed25519`);
  const keyId = stringAt(item.keyId, `${path}.keyId`, issues);
  if (!/^ed25519-sha256-[a-f0-9]{64}$/.test(keyId)) {
    issues.push(`${path}.keyId: expected Ed25519 SHA-256 key id`);
  }
  const publicKeySpkiBase64 = stringAt(
    item.publicKeySpkiBase64,
    `${path}.publicKeySpkiBase64`,
    issues,
  );
  const signedPayloadSha256 = stringAt(
    item.signedPayloadSha256,
    `${path}.signedPayloadSha256`,
    issues,
  );
  if (!SHA256.test(signedPayloadSha256)) {
    issues.push(`${path}.signedPayloadSha256: expected lowercase SHA-256`);
  }
  const signatureBase64 = stringAt(item.signatureBase64, `${path}.signatureBase64`, issues);
  if (item.semantics !== EVIDENCE_PASSPORT_SIGNATURE_SEMANTICS) {
    issues.push(`${path}.semantics: expected authorship-only statement`);
  }
  return {
    kind: "operator_authorship",
    algorithm: "Ed25519",
    keyId,
    publicKeySpkiBase64,
    signedPayloadSha256,
    signatureBase64,
    semantics: EVIDENCE_PASSPORT_SIGNATURE_SEMANTICS,
  };
}

export async function computePassportPayloadSha256(
  payload: DeployBenchEvidencePassport["payload"],
): Promise<string> {
  return canonicalSha256Hex(payload);
}

export async function verifyEvidencePassport(
  input: unknown,
): Promise<EvidencePassportVerification> {
  const structuralIssues: string[] = [];
  const semanticIssues: string[] = [];
  const root = objectAt(input, "$", structuralIssues);
  exactKeys(
    root,
    [
      "schemaVersion",
      "kind",
      "passportId",
      "canonicalization",
      "payloadSha256",
      "classification",
      "payload",
      "signatures",
    ],
    "$",
    structuralIssues,
  );
  if (root.schemaVersion !== EVIDENCE_PASSPORT_SCHEMA_VERSION) {
    structuralIssues.push(`$.schemaVersion: expected ${EVIDENCE_PASSPORT_SCHEMA_VERSION}`);
  }
  if (root.kind !== EVIDENCE_PASSPORT_KIND) {
    structuralIssues.push(`$.kind: expected ${EVIDENCE_PASSPORT_KIND}`);
  }
  const passportId = stringAt(root.passportId, "$.passportId", structuralIssues);
  if (!PASSPORT_ID.test(passportId)) {
    structuralIssues.push("$.passportId: expected deploybench-passport-sha256 identifier");
  }
  if (root.canonicalization !== EVIDENCE_PASSPORT_CANONICALIZATION) {
    structuralIssues.push(`$.canonicalization: expected ${EVIDENCE_PASSPORT_CANONICALIZATION}`);
  }
  const payloadSha256 = stringAt(root.payloadSha256, "$.payloadSha256", structuralIssues);
  if (!SHA256.test(payloadSha256)) {
    structuralIssues.push("$.payloadSha256: expected lowercase SHA-256");
  }

  const classification = objectAt(root.classification, "$.classification", structuralIssues);
  exactKeys(classification, ["evidenceClass", "comparisonEligible", "reason"], "$.classification", structuralIssues);
  if (classification.evidenceClass !== "measured") {
    structuralIssues.push("$.classification.evidenceClass: expected measured");
  }
  if (classification.comparisonEligible !== false) {
    structuralIssues.push("$.classification.comparisonEligible: passports must remain false");
  }
  stringAt(classification.reason, "$.classification.reason", structuralIssues);

  const payload = objectAt(root.payload, "$.payload", structuralIssues);
  exactKeys(payload, ["producer", "configurationSha256", "reproducibility", "trials"], "$.payload", structuralIssues);
  const producer = objectAt(payload.producer, "$.payload.producer", structuralIssues);
  exactKeys(producer, ["name", "version"], "$.payload.producer", structuralIssues);
  if (producer.name !== "@moemodels/bench") {
    structuralIssues.push("$.payload.producer.name: expected @moemodels/bench");
  }
  if (producer.version !== "0.1.0") {
    structuralIssues.push("$.payload.producer.version: expected 0.1.0");
  }
  const configurationSha256 = stringAt(
    payload.configurationSha256,
    "$.payload.configurationSha256",
    structuralIssues,
  );
  if (!SHA256.test(configurationSha256)) {
    structuralIssues.push("$.payload.configurationSha256: expected lowercase SHA-256");
  }

  const reproducibility = objectAt(
    payload.reproducibility,
    "$.payload.reproducibility",
    structuralIssues,
  );
  exactKeys(
    reproducibility,
    ["requiredTrials", "observedTrials", "complete", "gates", "missing"],
    "$.payload.reproducibility",
    structuralIssues,
  );
  if (reproducibility.requiredTrials !== EVIDENCE_PASSPORT_REQUIRED_TRIALS) {
    structuralIssues.push(`$.payload.reproducibility.requiredTrials: expected ${EVIDENCE_PASSPORT_REQUIRED_TRIALS}`);
  }
  integerAt(reproducibility.observedTrials, "$.payload.reproducibility.observedTrials", structuralIssues, 1);
  if (typeof reproducibility.complete !== "boolean") {
    structuralIssues.push("$.payload.reproducibility.complete: expected boolean");
  }
  arrayAt(reproducibility.gates, "$.payload.reproducibility.gates", structuralIssues).forEach(
    (gate, index) => {
      const gatePath = `$.payload.reproducibility.gates[${index}]`;
      const gateObject = objectAt(gate, gatePath, structuralIssues);
      exactKeys(gateObject, ["id", "passed", "detail"], gatePath, structuralIssues);
      stringAt(gateObject.id, `${gatePath}.id`, structuralIssues);
      if (typeof gateObject.passed !== "boolean") {
        structuralIssues.push(`${gatePath}.passed: expected boolean`);
      }
      stringAt(gateObject.detail, `${gatePath}.detail`, structuralIssues);
    },
  );
  arrayAt(reproducibility.missing, "$.payload.reproducibility.missing", structuralIssues).forEach(
    (entry, index) => stringAt(entry, `$.payload.reproducibility.missing[${index}]`, structuralIssues),
  );

  const trialValues = arrayAt(payload.trials, "$.payload.trials", structuralIssues);
  if (trialValues.length === 0) structuralIssues.push("$.payload.trials: expected at least one trial");
  let summariesValid = true;
  trialValues.forEach((trial, index) => {
    const result = validateEndpointBenchmarkResult(trial);
    if (!result.valid) {
      summariesValid = summariesValid && !result.issues.some((issue) => issue.includes("$.summary"));
      structuralIssues.push(
        ...result.structuralIssues.map(
          (issue) => `$.payload.trials[${index}]${issue.slice(1)}`,
        ),
      );
      semanticIssues.push(
        ...result.semanticIssues.map(
          (issue) => `$.payload.trials[${index}]${issue.slice(1)}`,
        ),
      );
    }
  });

  const signaturesInput = arrayAt(root.signatures, "$.signatures", structuralIssues);
  const signatures = signaturesInput.flatMap((entry, index) => {
    const signature = validateSignatureShape(entry, `$.signatures[${index}]`, structuralIssues);
    return signature === null ? [] : [signature];
  });
  const signatureKeyIds = signatures.map((signature) => signature.keyId);
  if (new Set(signatureKeyIds).size !== signatureKeyIds.length) {
    structuralIssues.push("$.signatures: duplicate signer key id");
  }

  let recomputedPayloadSha256 = "";
  let payloadDigestValid = false;
  let passportIdValid = false;
  let configurationDigestValid = false;
  let compatibleTrials = false;
  let reproducibilityClaimsValid = false;
  let recomputedReproducibility: ReproducibilityAssessment | null = null;

  if (structuralIssues.length === 0) {
    const typedPayload = payload as unknown as DeployBenchEvidencePassport["payload"];
    const typedTrials = typedPayload.trials;
    try {
      recomputedPayloadSha256 = await computePassportPayloadSha256(typedPayload);
      payloadDigestValid = recomputedPayloadSha256 === payloadSha256;
      if (!payloadDigestValid) semanticIssues.push("$.payloadSha256: does not match canonical payload bytes");
      passportIdValid = passportId === `deploybench-passport-sha256-${recomputedPayloadSha256}`;
      if (!passportIdValid) semanticIssues.push("$.passportId: does not match canonical payload digest");

      const configurations = typedTrials.map(endpointBenchmarkConfiguration);
      const firstConfiguration = configurations[0];
      compatibleTrials = firstConfiguration !== undefined && configurations.every((configuration) =>
        canonicalEqual(configuration, firstConfiguration),
      );
      if (!compatibleTrials) semanticIssues.push("$.payload.trials: incompatible trial configurations");
      if (firstConfiguration !== undefined) {
        configurationDigestValid =
          await canonicalSha256Hex(firstConfiguration) === configurationSha256;
      }
      if (!configurationDigestValid) {
        semanticIssues.push("$.payload.configurationSha256: does not match the trial configuration");
      }
      recomputedReproducibility = assessEvidencePassportTrials(typedTrials, compatibleTrials);
      reproducibilityClaimsValid = canonicalEqual(
        recomputedReproducibility,
        typedPayload.reproducibility,
      );
      if (!reproducibilityClaimsValid) {
        semanticIssues.push("$.payload.reproducibility: stored gates do not match recomputed gates");
      }
    } catch (error) {
      semanticIssues.push(
        `$.payload: ${error instanceof Error ? error.message : "canonical verification failed"}`,
      );
    }
  }

  const signatureResults = await Promise.all(
    signatures.map((signature) => verifySignature(signature, recomputedPayloadSha256 || payloadSha256)),
  );
  signatureResults.forEach((result, index) => {
    if (result.status === "invalid") {
      semanticIssues.push(`$.signatures[${index}]: ${result.issue ?? "invalid signature"}`);
    }
  });

  const issues = [...new Set([...structuralIssues, ...semanticIssues])].sort();
  return {
    valid: issues.length === 0,
    schemaValid: structuralIssues.length === 0,
    payloadDigestValid,
    passportIdValid,
    configurationDigestValid,
    summariesValid,
    compatibleTrials,
    reproducibilityClaimsValid,
    comparisonEligible: false,
    issues,
    recomputedReproducibility,
    signatures: signatureResults,
  };
}
