import type { Registry } from "./types.js";
import type {
  EvaluationClaim,
  EvaluationRegistry,
  EvaluationRun,
  EvaluationRunFilters,
} from "./evaluation-types.js";

type JsonObject = Record<string, unknown>;
const SENSITIVE_URL_KEY =
  /(api[_-]?key|access[_-]?token|auth|bearer|credential|password|secret|(?:^|[_-])(?:token|key|sig|signature)$)/i;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class EvaluationValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(`Evaluation validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}.`);
    this.name = "EvaluationValidationError";
    this.issues = issues;
  }
}

function objectAt(value: unknown, path: string, issues: string[]): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push(`${path}: expected object`);
    return {};
  }
  return value as JsonObject;
}

function arrayAt(value: unknown, path: string, issues: string[]): unknown[] {
  if (!Array.isArray(value)) {
    issues.push(`${path}: expected array`);
    return [];
  }
  return value;
}

function exactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key}: unexpected property`);
  }
  for (const key of required) {
    if (!(key in value)) issues.push(`${path}.${key}: missing property`);
  }
}

function stringAt(value: unknown, path: string, issues: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path}: expected non-empty string`);
    return "";
  }
  return value;
}

function finiteNumberAt(value: unknown, path: string, issues: string[]): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${path}: expected finite number`);
    return 0;
  }
  return value;
}

function nonNegativeIntegerAt(value: unknown, path: string, issues: string[]): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    issues.push(`${path}: expected non-negative safe integer`);
    return 0;
  }
  return value;
}

function safeIntegerAt(value: unknown, path: string, issues: string[]): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    issues.push(`${path}: expected safe integer`);
    return 0;
  }
  return value;
}

function positiveIntegerAt(value: unknown, path: string, issues: string[]): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    issues.push(`${path}: expected positive safe integer`);
    return 0;
  }
  return value;
}

function stringArrayAt(value: unknown, path: string, issues: string[], minimum = 0): string[] {
  const values = arrayAt(value, path, issues).map((entry, index) =>
    stringAt(entry, `${path}[${index}]`, issues),
  );
  if (values.length < minimum) issues.push(`${path}: expected at least ${minimum} item(s)`);
  return values;
}

function validateDate(value: unknown, path: string, issues: string[]): void {
  const date = stringAt(value, path, issues);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    issues.push(`${path}: expected YYYY-MM-DD date`);
    return;
  }
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    issues.push(`${path}: expected valid calendar date`);
  }
}

function dateTimeAt(value: unknown, path: string, issues: string[]): number | undefined {
  const dateTime = stringAt(value, path, issues);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(dateTime)) {
    issues.push(`${path}: expected an RFC 3339 UTC date-time`);
    return undefined;
  }
  const timestamp = Date.parse(dateTime);
  if (!Number.isFinite(timestamp)) {
    issues.push(`${path}: expected a valid date-time`);
    return undefined;
  }
  return timestamp;
}

function sha256At(value: unknown, path: string, issues: string[]): string {
  const digest = stringAt(value, path, issues);
  if (!/^[a-f0-9]{64}$/.test(digest)) issues.push(`${path}: expected full lowercase SHA-256`);
  return digest;
}

function validateHttpsUrl(value: unknown, path: string, issues: string[]): void {
  const url = stringAt(value, path, issues);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") issues.push(`${path}: expected https URL`);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      [...parsed.searchParams.keys()].some((key) => SENSITIVE_URL_KEY.test(key))
    ) {
      issues.push(`${path}: credentials and sensitive query parameters are forbidden`);
    }
  } catch {
    issues.push(`${path}: expected valid URL`);
  }
}

function validateProvenance(
  value: unknown,
  path: string,
  issues: string[],
  referencedSources?: Set<string>,
): void {
  const entries = arrayAt(value, path, issues);
  if (entries.length === 0) issues.push(`${path}: expected at least one provenance reference`);
  entries.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = objectAt(entry, itemPath, issues);
    exactKeys(item, ["sourceId"], ["locator"], itemPath, issues);
    const sourceId = stringAt(item.sourceId, `${itemPath}.sourceId`, issues);
    if (sourceId) referencedSources?.add(sourceId);
    if (item.locator !== undefined) stringAt(item.locator, `${itemPath}.locator`, issues);
  });
}

function validateClaim(
  value: unknown,
  path: string,
  issues: string[],
  validateKnown: (value: unknown, path: string, issues: string[]) => void,
  referencedSources?: Set<string>,
): void {
  const item = objectAt(value, path, issues);
  if (item.status === "known") {
    exactKeys(item, ["status", "value", "evidenceClass", "provenance"], [], path, issues);
    if (!["sourced", "measured", "calculated"].includes(String(item.evidenceClass))) {
      issues.push(`${path}.evidenceClass: expected sourced, measured, or calculated`);
    }
    validateKnown(item.value, `${path}.value`, issues);
    validateProvenance(item.provenance, `${path}.provenance`, issues, referencedSources);
    return;
  }
  if (item.status === "unknown") {
    exactKeys(item, ["status", "reason", "provenance"], [], path, issues);
    stringAt(item.reason, `${path}.reason`, issues);
    validateProvenance(item.provenance, `${path}.provenance`, issues, referencedSources);
    return;
  }
  issues.push(`${path}.status: expected known or unknown`);
}

const validateStringClaim = (
  value: unknown,
  path: string,
  issues: string[],
  sources?: Set<string>,
) => validateClaim(value, path, issues, (entry, entryPath, entryIssues) => {
  stringAt(entry, entryPath, entryIssues);
}, sources);

const validateNumberClaim = (
  value: unknown,
  path: string,
  issues: string[],
  sources?: Set<string>,
) => validateClaim(value, path, issues, (entry, entryPath, entryIssues) => {
  finiteNumberAt(entry, entryPath, entryIssues);
}, sources);

const validateIntegerClaim = (
  value: unknown,
  path: string,
  issues: string[],
  sources?: Set<string>,
) => validateClaim(value, path, issues, (entry, entryPath, entryIssues) => {
  nonNegativeIntegerAt(entry, entryPath, entryIssues);
}, sources);

function validateMetric(
  value: unknown,
  path: string,
  issues: string[],
  referencedSources?: Set<string>,
): void {
  const item = objectAt(value, path, issues);
  exactKeys(
    item,
    ["sourceKey", "name", "filter", "value", "standardError", "higherIsBetter", "sampleCount"],
    [],
    path,
    issues,
  );
  stringAt(item.sourceKey, `${path}.sourceKey`, issues);
  stringAt(item.name, `${path}.name`, issues);
  validateStringClaim(item.filter, `${path}.filter`, issues, referencedSources);
  validateNumberClaim(item.value, `${path}.value`, issues, referencedSources);
  validateNumberClaim(item.standardError, `${path}.standardError`, issues, referencedSources);
  validateClaim(item.higherIsBetter, `${path}.higherIsBetter`, issues, (entry, entryPath, entryIssues) => {
    if (typeof entry !== "boolean") entryIssues.push(`${entryPath}: expected boolean`);
  }, referencedSources);
  validateIntegerClaim(item.sampleCount, `${path}.sampleCount`, issues, referencedSources);
  const standardError = item.standardError as Partial<EvaluationClaim<number>>;
  if (standardError.status === "known" && typeof standardError.value === "number" && standardError.value < 0) {
    issues.push(`${path}.standardError.value: cannot be negative`);
  }
}

function validateTask(
  value: unknown,
  path: string,
  issues: string[],
  referencedSources?: Set<string>,
): void {
  const item = objectAt(value, path, issues);
  exactKeys(
    item,
    [
      "name",
      "alias",
      "version",
      "datasetPath",
      "datasetRevision",
      "taskHash",
      "fewShot",
      "originalSamples",
      "effectiveSamples",
      "metrics",
    ],
    [],
    path,
    issues,
  );
  stringAt(item.name, `${path}.name`, issues);
  validateStringClaim(item.alias, `${path}.alias`, issues, referencedSources);
  validateStringClaim(item.version, `${path}.version`, issues, referencedSources);
  validateStringClaim(item.datasetPath, `${path}.datasetPath`, issues, referencedSources);
  validateStringClaim(item.datasetRevision, `${path}.datasetRevision`, issues, referencedSources);
  validateStringClaim(item.taskHash, `${path}.taskHash`, issues, referencedSources);
  validateIntegerClaim(item.fewShot, `${path}.fewShot`, issues, referencedSources);
  validateIntegerClaim(item.originalSamples, `${path}.originalSamples`, issues, referencedSources);
  validateIntegerClaim(item.effectiveSamples, `${path}.effectiveSamples`, issues, referencedSources);
  const metricKeys = new Set<string>();
  arrayAt(item.metrics, `${path}.metrics`, issues).forEach((metric, index) => {
    validateMetric(metric, `${path}.metrics[${index}]`, issues, referencedSources);
    const key = (metric as JsonObject)?.sourceKey;
    if (typeof key === "string") {
      if (metricKeys.has(key)) issues.push(`${path}.metrics[${index}].sourceKey: duplicate ${key}`);
      metricKeys.add(key);
    }
  });
  if (!Array.isArray(item.metrics) || item.metrics.length === 0) {
    issues.push(`${path}.metrics: expected at least one metric`);
  }
  const original = item.originalSamples as Partial<EvaluationClaim<number>>;
  const effective = item.effectiveSamples as Partial<EvaluationClaim<number>>;
  if (
    original.status === "known" &&
    effective.status === "known" &&
    typeof original.value === "number" &&
    typeof effective.value === "number" &&
    effective.value > original.value
  ) {
    issues.push(`${path}.effectiveSamples.value: cannot exceed originalSamples.value`);
  }
}

function claimIsKnown(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as JsonObject).status === "known";
}

export function evaluationRunEligibilityMissing(run: EvaluationRun): string[] {
  const candidate = run as unknown as JsonObject;
  const model = typeof candidate.model === "object" && candidate.model !== null
    ? candidate.model as JsonObject
    : {};
  const harness = typeof candidate.harness === "object" && candidate.harness !== null
    ? candidate.harness as JsonObject
    : {};
  const execution = typeof candidate.execution === "object" && candidate.execution !== null
    ? candidate.execution as JsonObject
    : {};
  const missing: string[] = [];
  if (!claimIsKnown(model.registryModelId)) missing.push("model.registryModelId");
  if (!claimIsKnown(model.revision)) missing.push("model.revision");
  if (!claimIsKnown(harness.gitRevision) || harness.revisionCompleteness !== "full") {
    missing.push("harness.fullGitRevision");
  }
  if (!claimIsKnown(execution.executedAt)) missing.push("execution.executedAt");
  if (!claimIsKnown(execution.hardwareTopology)) missing.push("execution.hardwareTopology");
  if (!claimIsKnown(execution.runtimeVersion)) missing.push("execution.runtimeVersion");
  const tasks = Array.isArray(candidate.tasks) ? candidate.tasks : [];
  if (tasks.length === 0) missing.push("tasks");
  tasks.forEach((taskValue) => {
    const task = typeof taskValue === "object" && taskValue !== null
      ? taskValue as JsonObject
      : {};
    const taskName = typeof task.name === "string" && task.name !== "" ? task.name : "unknown";
    if (!claimIsKnown(task.datasetRevision)) {
      missing.push(`tasks.${taskName}.datasetRevision`);
    }
    if (!claimIsKnown(task.taskHash)) missing.push(`tasks.${taskName}.taskHash`);
    if (!claimIsKnown(task.fewShot)) missing.push(`tasks.${taskName}.fewShot`);
    if (!claimIsKnown(task.effectiveSamples)) {
      missing.push(`tasks.${taskName}.effectiveSamples`);
    }
    const metrics = Array.isArray(task.metrics) ? task.metrics : [];
    if (metrics.length === 0) missing.push(`tasks.${taskName}.metrics`);
    metrics.forEach((metricValue) => {
      const metric = typeof metricValue === "object" && metricValue !== null
        ? metricValue as JsonObject
        : {};
      const sourceKey = typeof metric.sourceKey === "string" && metric.sourceKey !== ""
        ? metric.sourceKey
        : "unknown";
      if (!claimIsKnown(metric.standardError)) {
        missing.push(`tasks.${taskName}.metrics.${sourceKey}.standardError`);
      }
      if (!claimIsKnown(metric.higherIsBetter)) {
        missing.push(`tasks.${taskName}.metrics.${sourceKey}.higherIsBetter`);
      }
    });
  });
  return [...new Set(missing)].sort();
}

function validateRun(
  value: unknown,
  path: string,
  issues: string[],
  referencedSources?: Set<string>,
  referencedArtifacts?: Set<string>,
  modelRegistry?: Registry,
): void {
  const item = objectAt(value, path, issues);
  exactKeys(
    item,
    ["id", "adapter", "publicationStatus", "rawArtifactIds", "model", "harness", "execution", "tasks", "groups", "diagnostics", "eligibility"],
    [],
    path,
    issues,
  );
  const id = stringAt(item.id, `${path}.id`, issues);
  if (!/^lm-eval-sha256-[a-f0-9]{64}$/.test(id)) {
    issues.push(`${path}.id: expected lm-eval-sha256- followed by a full lowercase SHA-256`);
  }
  if (!["eligible", "incomplete", "fixture_only", "withdrawn"].includes(String(item.publicationStatus))) {
    issues.push(`${path}.publicationStatus: invalid status`);
  }
  stringArrayAt(item.rawArtifactIds, `${path}.rawArtifactIds`, issues, 1).forEach((artifactId) =>
    referencedArtifacts?.add(artifactId),
  );

  const adapter = objectAt(item.adapter, `${path}.adapter`, issues);
  exactKeys(adapter, ["name", "version", "inputFamily"], [], `${path}.adapter`, issues);
  if (adapter.name !== "lm-eval") issues.push(`${path}.adapter.name: expected lm-eval`);
  if (adapter.version !== "0.1.0") issues.push(`${path}.adapter.version: expected 0.1.0`);
  if (!["legacy", "modern-v0.4"].includes(String(adapter.inputFamily))) {
    issues.push(`${path}.adapter.inputFamily: invalid input family`);
  }

  const model = objectAt(item.model, `${path}.model`, issues);
  exactKeys(model, ["registryModelId", "repository", "revision", "binding"], [], `${path}.model`, issues);
  validateStringClaim(model.registryModelId, `${path}.model.registryModelId`, issues, referencedSources);
  validateStringClaim(model.repository, `${path}.model.repository`, issues, referencedSources);
  validateStringClaim(model.revision, `${path}.model.revision`, issues, referencedSources);
  if (!["artifact_hash_match", "unresolved"].includes(String(model.binding))) {
    issues.push(`${path}.model.binding: invalid binding`);
  }
  const registryModelIdClaim = isObject(model.registryModelId)
    ? model.registryModelId
    : {};
  const repositoryClaim = isObject(model.repository) ? model.repository : {};
  const revisionClaim = isObject(model.revision) ? model.revision : {};
  const knownRegistryModelId =
    registryModelIdClaim.status === "known" && typeof registryModelIdClaim.value === "string"
      ? registryModelIdClaim.value
      : undefined;
  const knownRepository =
    repositoryClaim.status === "known" && typeof repositoryClaim.value === "string"
      ? repositoryClaim.value
      : undefined;
  const knownRevision =
    revisionClaim.status === "known" && typeof revisionClaim.value === "string"
      ? revisionClaim.value
      : undefined;
  if (knownRepository && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(knownRepository)) {
    issues.push(`${path}.model.repository.value: expected canonical model repository`);
  }
  if (knownRevision && !/^[a-f0-9]{40}$/.test(knownRevision)) {
    issues.push(`${path}.model.revision.value: expected pinned 40-character revision`);
  }
  const boundRegistryModel = modelRegistry?.models.find(
    (candidate) => candidate.id === knownRegistryModelId,
  );
  const exactModelBinding =
    knownRegistryModelId !== undefined &&
    knownRepository !== undefined &&
    knownRevision !== undefined &&
    (modelRegistry === undefined ||
      (boundRegistryModel !== undefined &&
        boundRegistryModel.artifact.repository === knownRepository &&
        boundRegistryModel.artifact.revision === knownRevision));
  if (model.binding === "artifact_hash_match" && !exactModelBinding) {
    issues.push(`${path}.model.binding: artifact_hash_match requires exact canonical model claims`);
  }
  if (model.binding === "unresolved" && exactModelBinding) {
    issues.push(`${path}.model.binding: exact canonical model claims require artifact_hash_match`);
  }

  const harness = objectAt(item.harness, `${path}.harness`, issues);
  exactKeys(harness, ["name", "version", "gitRevision", "revisionCompleteness"], [], `${path}.harness`, issues);
  if (harness.name !== "lm-evaluation-harness") {
    issues.push(`${path}.harness.name: expected lm-evaluation-harness`);
  }
  validateStringClaim(harness.version, `${path}.harness.version`, issues, referencedSources);
  validateStringClaim(harness.gitRevision, `${path}.harness.gitRevision`, issues, referencedSources);
  if (!["full", "abbreviated", "unknown"].includes(String(harness.revisionCompleteness))) {
    issues.push(`${path}.harness.revisionCompleteness: invalid completeness`);
  }

  const execution = objectAt(item.execution, `${path}.execution`, issues);
  exactKeys(
    execution,
    ["executedAt", "durationSeconds", "backend", "runtimeVersion", "device", "hardwareTopology", "dtype", "quantization", "batchSize", "limit", "seeds", "chatTemplateSha256", "systemInstructionSha256", "generationConfig"],
    [],
    `${path}.execution`,
    issues,
  );
  for (const key of ["executedAt", "durationSeconds", "backend", "runtimeVersion", "device", "hardwareTopology", "dtype", "batchSize"] as const) {
    validateStringClaim(execution[key], `${path}.execution.${key}`, issues, referencedSources);
  }
  validateClaim(execution.quantization, `${path}.execution.quantization`, issues, (entry, entryPath, entryIssues) => {
    if (entry !== null) stringAt(entry, entryPath, entryIssues);
  }, referencedSources);
  validateClaim(execution.limit, `${path}.execution.limit`, issues, (entry, entryPath, entryIssues) => {
    if (entry !== null) finiteNumberAt(entry, entryPath, entryIssues);
  }, referencedSources);
  validateClaim(execution.seeds, `${path}.execution.seeds`, issues, (entry, entryPath, entryIssues) => {
    const seeds = objectAt(entry, entryPath, entryIssues);
    exactKeys(seeds, ["random", "numpy", "torch", "fewshot"], [], entryPath, entryIssues);
    for (const key of ["random", "numpy", "torch", "fewshot"] as const) {
      if (typeof seeds[key] !== "number" || !Number.isSafeInteger(seeds[key])) {
        entryIssues.push(`${entryPath}.${key}: expected safe integer`);
      }
    }
  }, referencedSources);
  for (const key of ["chatTemplateSha256", "systemInstructionSha256"] as const) {
    validateClaim(execution[key], `${path}.execution.${key}`, issues, (entry, entryPath, entryIssues) => {
      if (entry !== null) {
        const digest = stringAt(entry, entryPath, entryIssues);
        if (!/^[a-f0-9]{64}$/.test(digest)) entryIssues.push(`${entryPath}: expected full lowercase SHA-256 or null`);
      }
    }, referencedSources);
  }
  validateClaim(execution.generationConfig, `${path}.execution.generationConfig`, issues, (entry, entryPath, entryIssues) => {
    if (entry !== null) objectAt(entry, entryPath, entryIssues);
  }, referencedSources);

  const taskNames = new Set<string>();
  const tasks = arrayAt(item.tasks, `${path}.tasks`, issues);
  if (tasks.length === 0) issues.push(`${path}.tasks: expected at least one task`);
  tasks.forEach((task, index) => {
    validateTask(task, `${path}.tasks[${index}]`, issues, referencedSources);
    const name = (task as JsonObject)?.name;
    if (typeof name === "string") {
      if (taskNames.has(name)) issues.push(`${path}.tasks[${index}].name: duplicate ${name}`);
      taskNames.add(name);
    }
  });
  arrayAt(item.groups, `${path}.groups`, issues).forEach((group, index) => {
    const groupPath = `${path}.groups[${index}]`;
    const groupObject = objectAt(group, groupPath, issues);
    exactKeys(groupObject, ["name", "taskNames", "metrics"], [], groupPath, issues);
    stringAt(groupObject.name, `${groupPath}.name`, issues);
    stringArrayAt(groupObject.taskNames, `${groupPath}.taskNames`, issues).forEach((taskName) => {
      if (!taskNames.has(taskName)) issues.push(`${groupPath}.taskNames: unknown task ${taskName}`);
    });
    arrayAt(groupObject.metrics, `${groupPath}.metrics`, issues).forEach((metric, metricIndex) =>
      validateMetric(metric, `${groupPath}.metrics[${metricIndex}]`, issues, referencedSources),
    );
  });
  arrayAt(item.diagnostics, `${path}.diagnostics`, issues).forEach((diagnostic, index) => {
    const diagnosticPath = `${path}.diagnostics[${index}]`;
    const diagnosticObject = objectAt(diagnostic, diagnosticPath, issues);
    exactKeys(diagnosticObject, ["code", "severity", "message"], ["locator"], diagnosticPath, issues);
    stringAt(diagnosticObject.code, `${diagnosticPath}.code`, issues);
    stringAt(diagnosticObject.message, `${diagnosticPath}.message`, issues);
    if (!["info", "warning", "error"].includes(String(diagnosticObject.severity))) {
      issues.push(`${diagnosticPath}.severity: invalid severity`);
    }
    if (diagnosticObject.locator !== undefined) stringAt(diagnosticObject.locator, `${diagnosticPath}.locator`, issues);
  });
  const eligibility = objectAt(item.eligibility, `${path}.eligibility`, issues);
  exactKeys(eligibility, ["status", "missing"], [], `${path}.eligibility`, issues);
  if (!["eligible", "insufficient"].includes(String(eligibility.status))) {
    issues.push(`${path}.eligibility.status: invalid eligibility`);
  }
  const missing = stringArrayAt(eligibility.missing, `${path}.eligibility.missing`, issues);
  const recomputedMissing = evaluationRunEligibilityMissing(item as unknown as EvaluationRun);
  if (
    JSON.stringify([...missing].sort()) !== JSON.stringify(recomputedMissing)
  ) {
    issues.push(`${path}.eligibility.missing: must equal the deterministically recomputed gaps`);
  }
  const recomputedStatus = recomputedMissing.length === 0 ? "eligible" : "insufficient";
  if (eligibility.status !== recomputedStatus) {
    issues.push(`${path}.eligibility.status: must match the deterministically recomputed gaps`);
  }
  if (item.publicationStatus === "fixture_only" && eligibility.status === "eligible") {
    issues.push(`${path}.eligibility.status: fixture_only runs cannot be eligible`);
  }
  if (item.publicationStatus === "eligible" && (recomputedStatus !== "eligible" || model.binding !== "artifact_hash_match")) {
    issues.push(`${path}: publication-eligible runs require an exact model binding and no eligibility gaps`);
  }
}

export function validateEvaluationRun(
  input: unknown,
  modelRegistry?: Registry,
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  validateRun(input, "$", issues, undefined, undefined, modelRegistry);
  return { valid: issues.length === 0, issues };
}

export function parseEvaluationRun(input: unknown, modelRegistry?: Registry): EvaluationRun {
  const result = validateEvaluationRun(input, modelRegistry);
  if (!result.valid) throw new EvaluationValidationError(result.issues);
  return input as EvaluationRun;
}

function validateComparisonFingerprint(
  value: unknown,
  path: string,
  issues: string[],
  adapter?: JsonObject,
  hardwareIds?: Set<string>,
): void {
  const item = objectAt(value, path, issues);
  exactKeys(
    item,
    [
      "canonicalization",
      "harness",
      "task",
      "chatTemplateSha256",
      "systemPromptSha256",
      "reasoningConfigSha256",
      "samplingConfigSha256",
      "seeds",
      "samples",
      "runtime",
      "hardware",
    ],
    [],
    path,
    issues,
  );

  const canonicalization = objectAt(
    item.canonicalization,
    `${path}.canonicalization`,
    issues,
  );
  exactKeys(
    canonicalization,
    ["scheme", "textEncoding", "absentValue", "hardwareRegistryVersion"],
    [],
    `${path}.canonicalization`,
    issues,
  );
  if (canonicalization.scheme !== "RFC8785") {
    issues.push(`${path}.canonicalization.scheme: expected RFC8785`);
  }
  if (canonicalization.textEncoding !== "UTF-8") {
    issues.push(`${path}.canonicalization.textEncoding: expected UTF-8`);
  }
  if (canonicalization.absentValue !== "JSON null") {
    issues.push(`${path}.canonicalization.absentValue: expected JSON null`);
  }
  if (canonicalization.hardwareRegistryVersion !== "1.0.0") {
    issues.push(`${path}.canonicalization.hardwareRegistryVersion: expected 1.0.0`);
  }

  const harness = objectAt(item.harness, `${path}.harness`, issues);
  exactKeys(harness, ["name", "version", "revision"], [], `${path}.harness`, issues);
  const harnessName = stringAt(harness.name, `${path}.harness.name`, issues);
  const harnessVersion = stringAt(harness.version, `${path}.harness.version`, issues);
  const harnessRevision = stringAt(harness.revision, `${path}.harness.revision`, issues);
  if (harnessName !== "lm-evaluation-harness") {
    issues.push(`${path}.harness.name: expected lm-evaluation-harness`);
  }
  if (!/^[a-f0-9]{40}$/.test(harnessRevision)) {
    issues.push(`${path}.harness.revision: expected pinned 40-character revision`);
  }
  if (adapter) {
    if (harnessVersion !== adapter.version) {
      issues.push(`${path}.harness.version: must match the referenced adapter version`);
    }
    if (harnessRevision !== adapter.revision) {
      issues.push(`${path}.harness.revision: must match the referenced adapter revision`);
    }
  }

  const task = objectAt(item.task, `${path}.task`, issues);
  exactKeys(task, ["hash", "version", "datasetRevision"], [], `${path}.task`, issues);
  sha256At(task.hash, `${path}.task.hash`, issues);
  stringAt(task.version, `${path}.task.version`, issues);
  const datasetRevision = stringAt(
    task.datasetRevision,
    `${path}.task.datasetRevision`,
    issues,
  );
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(datasetRevision)) {
    issues.push(`${path}.task.datasetRevision: expected immutable 40- or 64-character revision`);
  }

  for (const key of [
    "chatTemplateSha256",
    "systemPromptSha256",
    "reasoningConfigSha256",
    "samplingConfigSha256",
  ] as const) {
    sha256At(item[key], `${path}.${key}`, issues);
  }

  const seeds = objectAt(item.seeds, `${path}.seeds`, issues);
  exactKeys(seeds, ["random", "numpy", "torch", "fewshot"], [], `${path}.seeds`, issues);
  for (const key of ["random", "numpy", "torch", "fewshot"] as const) {
    safeIntegerAt(seeds[key], `${path}.seeds.${key}`, issues);
  }

  const samples = objectAt(item.samples, `${path}.samples`, issues);
  exactKeys(
    samples,
    ["original", "effective", "limit", "repetitions"],
    [],
    `${path}.samples`,
    issues,
  );
  const original = positiveIntegerAt(samples.original, `${path}.samples.original`, issues);
  const effective = positiveIntegerAt(samples.effective, `${path}.samples.effective`, issues);
  if (effective > original) {
    issues.push(`${path}.samples.effective: cannot exceed original samples`);
  }
  if (samples.limit !== null) {
    positiveIntegerAt(samples.limit, `${path}.samples.limit`, issues);
  }
  positiveIntegerAt(samples.repetitions, `${path}.samples.repetitions`, issues);

  const runtime = objectAt(item.runtime, `${path}.runtime`, issues);
  exactKeys(runtime, ["name", "version", "precision"], [], `${path}.runtime`, issues);
  for (const key of ["name", "version", "precision"] as const) {
    const runtimeValue = stringAt(runtime[key], `${path}.runtime.${key}`, issues);
    if (
      key !== "version" &&
      !/^[a-z0-9][a-z0-9._/-]*$/.test(runtimeValue)
    ) {
      issues.push(`${path}.runtime.${key}: expected canonical lowercase identifier`);
    }
  }

  const hardware = objectAt(item.hardware, `${path}.hardware`, issues);
  exactKeys(
    hardware,
    ["acceleratorId", "acceleratorCount", "nodeCount", "devicesPerNode", "interconnect"],
    [],
    `${path}.hardware`,
    issues,
  );
  const acceleratorId = stringAt(
    hardware.acceleratorId,
    `${path}.hardware.acceleratorId`,
    issues,
  );
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(acceleratorId)) {
    issues.push(`${path}.hardware.acceleratorId: expected canonical lowercase registry id`);
  }
  if (hardwareIds && !hardwareIds.has(acceleratorId)) {
    issues.push(`${path}.hardware.acceleratorId: unknown registry hardware ${acceleratorId}`);
  }
  positiveIntegerAt(hardware.acceleratorCount, `${path}.hardware.acceleratorCount`, issues);
  positiveIntegerAt(hardware.nodeCount, `${path}.hardware.nodeCount`, issues);
  positiveIntegerAt(hardware.devicesPerNode, `${path}.hardware.devicesPerNode`, issues);
  const interconnect = stringAt(
    hardware.interconnect,
    `${path}.hardware.interconnect`,
    issues,
  );
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(interconnect)) {
    issues.push(`${path}.hardware.interconnect: expected canonical lowercase identifier`);
  }
}

export function validateEvaluationRegistry(
  input: unknown,
  modelRegistry?: Registry,
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const root = objectAt(input, "$", issues);
  exactKeys(root, ["$schema", "schemaVersion", "generatedAt", "sources", "adapters", "reportedClaims", "rawArtifacts", "runs"], [], "$", issues);
  stringAt(root.$schema, "$.$schema", issues);
  if (root.schemaVersion !== "1.0.0") issues.push("$.schemaVersion: expected 1.0.0");
  validateDate(root.generatedAt, "$.generatedAt", issues);

  const sourceIds = new Set<string>();
  const sourcesById = new Map<string, JsonObject>();
  const sources = arrayAt(root.sources, "$.sources", issues);
  if (sources.length === 0) issues.push("$.sources: expected at least one source");
  sources.forEach((source, index) => {
    const path = `$.sources[${index}]`;
    const item = objectAt(source, path, issues);
    exactKeys(
      item,
      ["id", "title", "publisher", "url", "retrievedAt", "sourceType"],
      ["publishedAt", "locator", "license", "licenseLocator", "artifactSnapshot"],
      path,
      issues,
    );
    const id = stringAt(item.id, `${path}.id`, issues);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) issues.push(`${path}.id: expected lowercase slug`);
    if (sourceIds.has(id)) issues.push(`${path}.id: duplicate ${id}`);
    sourceIds.add(id);
    if (id) sourcesById.set(id, item);
    stringAt(item.title, `${path}.title`, issues);
    stringAt(item.publisher, `${path}.publisher`, issues);
    validateHttpsUrl(item.url, `${path}.url`, issues);
    validateDate(item.retrievedAt, `${path}.retrievedAt`, issues);
    if (item.publishedAt !== undefined) {
      validateDate(item.publishedAt, `${path}.publishedAt`, issues);
    }
    for (const key of ["locator", "license", "licenseLocator"] as const) {
      if (item[key] !== undefined) stringAt(item[key], `${path}.${key}`, issues);
    }
    if (!["official_model_card", "technical_report", "adapter_repository", "evaluation_artifact"].includes(String(item.sourceType))) {
      issues.push(`${path}.sourceType: invalid source type`);
    }
    if (item.artifactSnapshot !== undefined) {
      const artifact = objectAt(item.artifactSnapshot, `${path}.artifactSnapshot`, issues);
      exactKeys(artifact, ["repository", "revision"], [], `${path}.artifactSnapshot`, issues);
      stringAt(artifact.repository, `${path}.artifactSnapshot.repository`, issues);
      const revision = stringAt(artifact.revision, `${path}.artifactSnapshot.revision`, issues);
      if (!/^[a-f0-9]{40}$/.test(revision)) issues.push(`${path}.artifactSnapshot.revision: expected pinned 40-character revision`);
    }
  });

  const adapterIds = new Set<string>();
  const adaptersById = new Map<string, JsonObject>();
  const adapters = arrayAt(root.adapters, "$.adapters", issues);
  if (adapters.length === 0) issues.push("$.adapters: expected at least one adapter");
  adapters.forEach((adapter, index) => {
    const path = `$.adapters[${index}]`;
    const item = objectAt(adapter, path, issues);
    exactKeys(item, ["id", "name", "kind", "packageName", "version", "repositoryUrl", "revision", "revisionUrl", "status", "sourceIds"], [], path, issues);
    const id = stringAt(item.id, `${path}.id`, issues);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) issues.push(`${path}.id: expected lowercase slug`);
    if (adapterIds.has(id)) issues.push(`${path}.id: duplicate ${id}`);
    adapterIds.add(id);
    if (id) adaptersById.set(id, item);
    stringAt(item.name, `${path}.name`, issues);
    if (item.kind !== "lm_eval") issues.push(`${path}.kind: expected lm_eval`);
    if (item.packageName !== "lm-eval") issues.push(`${path}.packageName: expected lm-eval`);
    if (item.version !== "0.4.12") issues.push(`${path}.version: expected 0.4.12`);
    validateHttpsUrl(item.repositoryUrl, `${path}.repositoryUrl`, issues);
    const revision = stringAt(item.revision, `${path}.revision`, issues);
    if (revision !== "6d642546f4688648fced259eb3302efd36ece5af") {
      issues.push(`${path}.revision: expected the v0.4.12 reference-harness commit`);
    }
    validateHttpsUrl(item.revisionUrl, `${path}.revisionUrl`, issues);
    if (typeof item.revisionUrl === "string" && !item.revisionUrl.includes(revision)) {
      issues.push(`${path}.revisionUrl: must include the pinned adapter revision`);
    }
    if (item.status !== "pinned_not_executed") issues.push(`${path}.status: expected pinned_not_executed`);
    const adapterSourceIds = stringArrayAt(item.sourceIds, `${path}.sourceIds`, issues, 1);
    if (new Set(adapterSourceIds).size !== adapterSourceIds.length) {
      issues.push(`${path}.sourceIds: expected unique source ids`);
    }
    adapterSourceIds.forEach((sourceId) => {
      if (!sourceIds.has(sourceId)) issues.push(`${path}.sourceIds: unknown source ${sourceId}`);
      const source = sourcesById.get(sourceId);
      if (source && source.sourceType !== "adapter_repository") {
        issues.push(`${path}.sourceIds: adapter sources must use adapter_repository`);
      }
    });
  });

  const modelIds = new Set(modelRegistry?.models.map((model) => model.id) ?? []);
  const hardwareIds = new Set(modelRegistry?.hardware.map((hardware) => hardware.id) ?? []);
  const modelsById = new Map(modelRegistry?.models.map((model) => [model.id, model]) ?? []);
  const claimIds = new Set<string>();
  const reportedClaims = arrayAt(root.reportedClaims, "$.reportedClaims", issues);
  if (reportedClaims.length === 0) {
    issues.push("$.reportedClaims: expected at least one reported claim");
  }
  reportedClaims.forEach((claim, index) => {
    const path = `$.reportedClaims[${index}]`;
    const item = objectAt(claim, path, issues);
    exactKeys(item, ["id", "claimType", "modelId", "modelName", "owner", "artifact", "artifactAssociation", "executionArtifactDigest", "benchmark", "metric", "evaluation", "sourceRefs", "comparisonEligible", "missingContext"], [], path, issues);
    const id = stringAt(item.id, `${path}.id`, issues);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) issues.push(`${path}.id: expected lowercase slug`);
    if (claimIds.has(id)) issues.push(`${path}.id: duplicate ${id}`);
    claimIds.add(id);
    const modelId = stringAt(item.modelId, `${path}.modelId`, issues);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(modelId)) {
      issues.push(`${path}.modelId: expected lowercase slug`);
    }
    if (modelRegistry && !modelIds.has(modelId)) issues.push(`${path}.modelId: unknown registry model ${modelId}`);
    const registryModel = modelsById.get(modelId);
    if (item.claimType !== "owner_reported") issues.push(`${path}.claimType: expected owner_reported`);
    const modelName = stringAt(item.modelName, `${path}.modelName`, issues);
    stringAt(item.owner, `${path}.owner`, issues);
    const artifact = objectAt(item.artifact, `${path}.artifact`, issues);
    exactKeys(artifact, ["repository", "revision"], [], `${path}.artifact`, issues);
    stringAt(artifact.repository, `${path}.artifact.repository`, issues);
    const artifactRevision = stringAt(artifact.revision, `${path}.artifact.revision`, issues);
    if (!/^[a-f0-9]{40}$/.test(artifactRevision)) issues.push(`${path}.artifact.revision: expected pinned 40-character revision`);
    if (
      registryModel &&
      (artifact.repository !== registryModel.artifact.repository ||
        artifactRevision !== registryModel.artifact.revision)
    ) {
      issues.push(`${path}.artifact: must exactly match the referenced registry model artifact`);
    }
    if (registryModel && modelName !== registryModel.name) {
      issues.push(`${path}.modelName: must match the referenced registry model name`);
    }
    if (!["artifact_snapshot_associated", "model_name_only"].includes(String(item.artifactAssociation))) {
      issues.push(`${path}.artifactAssociation: invalid association`);
    }
    if (item.executionArtifactDigest !== null) issues.push(`${path}.executionArtifactDigest: expected null until a run digest is published`);
    if (item.comparisonEligible !== false) issues.push(`${path}.comparisonEligible: owner-reported claims are not comparison eligible`);
    const benchmark = objectAt(item.benchmark, `${path}.benchmark`, issues);
    exactKeys(benchmark, ["suite", "version", "subset"], [], `${path}.benchmark`, issues);
    stringAt(benchmark.suite, `${path}.benchmark.suite`, issues);
    for (const key of ["version", "subset"] as const) {
      if (benchmark[key] !== null) stringAt(benchmark[key], `${path}.benchmark.${key}`, issues);
    }
    const metric = objectAt(item.metric, `${path}.metric`, issues);
    exactKeys(metric, ["name", "value", "unit", "scale", "direction"], [], `${path}.metric`, issues);
    stringAt(metric.name, `${path}.metric.name`, issues);
    finiteNumberAt(metric.value, `${path}.metric.value`, issues);
    if (!["reported_score", "percentage_points"].includes(String(metric.unit))) issues.push(`${path}.metric.unit: invalid unit`);
    if (metric.scale !== null) stringAt(metric.scale, `${path}.metric.scale`, issues);
    if (!["higher_is_better", "lower_is_better"].includes(String(metric.direction))) issues.push(`${path}.metric.direction: invalid direction`);
    const evaluation = objectAt(item.evaluation, `${path}.evaluation`, issues);
    exactKeys(evaluation, ["mode", "reportedSettings"], [], `${path}.evaluation`, issues);
    stringAt(evaluation.mode, `${path}.evaluation.mode`, issues);
    const reportedSettings = arrayAt(
      evaluation.reportedSettings,
      `${path}.evaluation.reportedSettings`,
      issues,
    );
    if (reportedSettings.length === 0) {
      issues.push(`${path}.evaluation.reportedSettings: expected at least one setting`);
    }
    const reportedSettingNames = new Set<string>();
    reportedSettings.forEach((setting, settingIndex) => {
      const settingPath = `${path}.evaluation.reportedSettings[${settingIndex}]`;
      const settingObject = objectAt(setting, settingPath, issues);
      exactKeys(settingObject, ["name", "value"], [], settingPath, issues);
      const name = stringAt(settingObject.name, `${settingPath}.name`, issues);
      if (reportedSettingNames.has(name)) issues.push(`${settingPath}.name: duplicate ${name}`);
      reportedSettingNames.add(name);
      if (!/^[a-z][a-z0-9_]*$/.test(name)) issues.push(`${settingPath}.name: expected snake_case setting name`);
      if (!["string", "number", "boolean"].includes(typeof settingObject.value) && settingObject.value !== null) {
        issues.push(`${settingPath}.value: expected scalar or null`);
      }
    });
    const sourceRefs = arrayAt(item.sourceRefs, `${path}.sourceRefs`, issues);
    if (sourceRefs.length === 0) issues.push(`${path}.sourceRefs: expected at least one source reference`);
    sourceRefs.forEach((sourceRef, sourceIndex) => {
      const sourcePath = `${path}.sourceRefs[${sourceIndex}]`;
      const source = objectAt(sourceRef, sourcePath, issues);
      exactKeys(source, ["sourceId", "locator"], [], sourcePath, issues);
      const sourceId = stringAt(source.sourceId, `${sourcePath}.sourceId`, issues);
      if (!sourceIds.has(sourceId)) issues.push(`${sourcePath}.sourceId: unknown source ${sourceId}`);
      stringAt(source.locator, `${sourcePath}.locator`, issues);
    });
    if (item.artifactAssociation === "artifact_snapshot_associated") {
      const hasMatchingSnapshot = sourceRefs.some((sourceRef) => {
        const sourceId = (sourceRef as JsonObject).sourceId;
        const snapshot = sourcesById.get(String(sourceId))?.artifactSnapshot;
        if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
          return false;
        }
        const snapshotObject = snapshot as JsonObject;
        return (
          snapshotObject.repository === artifact.repository &&
          snapshotObject.revision === artifactRevision
        );
      });
      if (!hasMatchingSnapshot) {
        issues.push(
          `${path}.sourceRefs: artifact_snapshot_associated requires a source pinned to the same artifact`,
        );
      }
    }
    const missingContext = stringArrayAt(item.missingContext, `${path}.missingContext`, issues, 1);
    if (new Set(missingContext).size !== missingContext.length) {
      issues.push(`${path}.missingContext: expected unique context gaps`);
    }
  });

  const artifactIds = new Set<string>();
  const artifactsById = new Map<string, JsonObject>();
  arrayAt(root.rawArtifacts, "$.rawArtifacts", issues).forEach((artifact, index) => {
    const path = `$.rawArtifacts[${index}]`;
    const item = objectAt(artifact, path, issues);
    exactKeys(item, ["id", "runId", "adapterId", "sourceId", "kind", "mediaType", "uri", "sha256", "byteLength"], [], path, issues);
    const id = stringAt(item.id, `${path}.id`, issues);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) issues.push(`${path}.id: expected lowercase slug`);
    if (artifactIds.has(id)) issues.push(`${path}.id: duplicate ${id}`);
    artifactIds.add(id);
    if (id) artifactsById.set(id, item);
    const artifactRunId = stringAt(item.runId, `${path}.runId`, issues);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(artifactRunId)) {
      issues.push(`${path}.runId: expected lowercase slug`);
    }
    const adapterId = stringAt(item.adapterId, `${path}.adapterId`, issues);
    if (!adapterIds.has(adapterId)) issues.push(`${path}.adapterId: unknown adapter ${adapterId}`);
    const sourceId = stringAt(item.sourceId, `${path}.sourceId`, issues);
    const artifactSource = sourcesById.get(sourceId);
    if (!artifactSource) {
      issues.push(`${path}.sourceId: unknown source ${sourceId}`);
    } else {
      if (artifactSource.sourceType !== "evaluation_artifact") {
        issues.push(`${path}.sourceId: raw artifacts require an evaluation_artifact source`);
      }
      if (item.uri !== artifactSource.url) {
        issues.push(`${path}.uri: must match the referenced evaluation artifact source URL`);
      }
    }
    if (!["lm_eval_results", "lm_eval_samples", "run_manifest"].includes(String(item.kind))) issues.push(`${path}.kind: invalid artifact kind`);
    stringAt(item.mediaType, `${path}.mediaType`, issues);
    stringAt(item.uri, `${path}.uri`, issues);
    const digest = stringAt(item.sha256, `${path}.sha256`, issues);
    if (!/^[a-f0-9]{64}$/.test(digest)) issues.push(`${path}.sha256: expected full lowercase SHA-256`);
    positiveIntegerAt(item.byteLength, `${path}.byteLength`, issues);
  });

  const runIds = new Set<string>();
  const runArtifactIdsByRunId = new Map<string, Set<string>>();
  arrayAt(root.runs, "$.runs", issues).forEach((run, index) => {
    const path = `$.runs[${index}]`;
    const item = objectAt(run, path, issues);
    exactKeys(item, ["id", "runType", "adapterId", "modelId", "artifact", "executionArtifactDigest", "benchmark", "metrics", "settings", "fingerprint", "rawArtifactIds", "startedAt", "completedAt", "comparisonEligible", "comparisonEligibilityReasons"], [], path, issues);
    const id = stringAt(item.id, `${path}.id`, issues);
    if (runIds.has(id)) issues.push(`${path}.id: duplicate ${id}`);
    if (claimIds.has(id)) issues.push(`${path}.id: duplicate evidence record id ${id}`);
    runIds.add(id);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) issues.push(`${path}.id: expected lowercase slug`);
    if (item.runType !== "normalized") issues.push(`${path}.runType: expected normalized`);
    const adapterId = stringAt(item.adapterId, `${path}.adapterId`, issues);
    if (!adapterIds.has(adapterId)) issues.push(`${path}.adapterId: unknown adapter ${adapterId}`);
    const referencedAdapter = adaptersById.get(adapterId);
    const modelId = stringAt(item.modelId, `${path}.modelId`, issues);
    if (modelRegistry && !modelIds.has(modelId)) issues.push(`${path}.modelId: unknown registry model ${modelId}`);
    const referencedModel = modelsById.get(modelId);
    const artifact = objectAt(item.artifact, `${path}.artifact`, issues);
    exactKeys(artifact, ["repository", "revision"], [], `${path}.artifact`, issues);
    stringAt(artifact.repository, `${path}.artifact.repository`, issues);
    const revision = stringAt(artifact.revision, `${path}.artifact.revision`, issues);
    if (!/^[a-f0-9]{40}$/.test(revision)) issues.push(`${path}.artifact.revision: expected pinned 40-character revision`);
    if (
      referencedModel &&
      (artifact.repository !== referencedModel.artifact.repository ||
        revision !== referencedModel.artifact.revision)
    ) {
      issues.push(`${path}.artifact: must exactly match the referenced registry model artifact`);
    }
    const executionDigest = sha256At(
      item.executionArtifactDigest,
      `${path}.executionArtifactDigest`,
      issues,
    );
    const benchmark = objectAt(item.benchmark, `${path}.benchmark`, issues);
    exactKeys(benchmark, ["suite", "version", "subset"], [], `${path}.benchmark`, issues);
    stringAt(benchmark.suite, `${path}.benchmark.suite`, issues);
    for (const key of ["version", "subset"] as const) if (benchmark[key] !== null) stringAt(benchmark[key], `${path}.benchmark.${key}`, issues);
    const metrics = arrayAt(item.metrics, `${path}.metrics`, issues);
    if (metrics.length === 0) issues.push(`${path}.metrics: expected at least one metric`);
    const metricNames = new Set<string>();
    metrics.forEach((metric, metricIndex) => {
      const metricPath = `${path}.metrics[${metricIndex}]`;
      const metricObject = objectAt(metric, metricPath, issues);
      exactKeys(
        metricObject,
        ["sourceKey", "name", "filter", "value", "standardError", "sampleCount", "unit", "direction"],
        [],
        metricPath,
        issues,
      );
      const sourceKey = stringAt(metricObject.sourceKey, `${metricPath}.sourceKey`, issues);
      stringAt(metricObject.name, `${metricPath}.name`, issues);
      stringAt(metricObject.filter, `${metricPath}.filter`, issues);
      if (metricNames.has(sourceKey)) issues.push(`${metricPath}.sourceKey: duplicate ${sourceKey}`);
      metricNames.add(sourceKey);
      finiteNumberAt(metricObject.value, `${metricPath}.value`, issues);
      const standardError = finiteNumberAt(
        metricObject.standardError,
        `${metricPath}.standardError`,
        issues,
      );
      if (standardError < 0) issues.push(`${metricPath}.standardError: cannot be negative`);
      positiveIntegerAt(metricObject.sampleCount, `${metricPath}.sampleCount`, issues);
      stringAt(metricObject.unit, `${metricPath}.unit`, issues);
      if (!["higher_is_better", "lower_is_better"].includes(String(metricObject.direction))) issues.push(`${metricPath}.direction: invalid direction`);
    });
    const settings = arrayAt(item.settings, `${path}.settings`, issues);
    if (settings.length === 0) issues.push(`${path}.settings: expected at least one setting`);
    const settingNames = new Set<string>();
    settings.forEach((setting, settingIndex) => {
      const settingPath = `${path}.settings[${settingIndex}]`;
      const settingObject = objectAt(setting, settingPath, issues);
      exactKeys(settingObject, ["name", "value"], [], settingPath, issues);
      const settingName = stringAt(settingObject.name, `${settingPath}.name`, issues);
      if (!/^[a-z][a-z0-9_]*$/.test(settingName)) {
        issues.push(`${settingPath}.name: expected snake_case setting name`);
      }
      if (settingNames.has(settingName)) issues.push(`${settingPath}.name: duplicate ${settingName}`);
      settingNames.add(settingName);
      if (!["string", "number", "boolean"].includes(typeof settingObject.value) && settingObject.value !== null) issues.push(`${settingPath}.value: expected scalar or null`);
    });
    validateComparisonFingerprint(
      item.fingerprint,
      `${path}.fingerprint`,
      issues,
      referencedAdapter,
      modelRegistry ? hardwareIds : undefined,
    );
    const fingerprint = isObject(item.fingerprint) ? item.fingerprint : {};
    const fingerprintTask = isObject(fingerprint.task) ? fingerprint.task : {};
    const fingerprintSamples = isObject(fingerprint.samples) ? fingerprint.samples : {};
    const fingerprintHardware = isObject(fingerprint.hardware) ? fingerprint.hardware : {};
    if (benchmark.version !== fingerprintTask.version) {
      issues.push(`${path}.benchmark.version: must match fingerprint.task.version`);
    }
    if (
      typeof fingerprintSamples.original === "number" &&
      typeof fingerprintSamples.effective === "number" &&
      fingerprintSamples.effective > fingerprintSamples.original
    ) {
      issues.push(`${path}.fingerprint.samples.effective: cannot exceed original samples`);
    }
    if (
      typeof fingerprintSamples.limit === "number" &&
      typeof fingerprintSamples.effective === "number" &&
      fingerprintSamples.effective > fingerprintSamples.limit
    ) {
      issues.push(`${path}.fingerprint.samples.effective: cannot exceed the declared limit`);
    }
    metrics.forEach((metric, metricIndex) => {
      const metricObject = isObject(metric) ? metric : {};
      if (
        typeof fingerprintSamples.effective === "number" &&
        metricObject.sampleCount !== fingerprintSamples.effective
      ) {
        issues.push(
          `${path}.metrics[${metricIndex}].sampleCount: must match fingerprint.samples.effective`,
        );
      }
    });
    if (
      typeof fingerprintHardware.acceleratorCount === "number" &&
      typeof fingerprintHardware.nodeCount === "number" &&
      typeof fingerprintHardware.devicesPerNode === "number" &&
      fingerprintHardware.acceleratorCount !==
        fingerprintHardware.nodeCount * fingerprintHardware.devicesPerNode
    ) {
      issues.push(
        `${path}.fingerprint.hardware.acceleratorCount: must equal nodeCount × devicesPerNode in v1`,
      );
    }
    const referencedRawArtifactIds = stringArrayAt(
      item.rawArtifactIds,
      `${path}.rawArtifactIds`,
      issues,
      1,
    );
    const seenArtifactIds = new Set<string>();
    runArtifactIdsByRunId.set(id, seenArtifactIds);
    let digestMatchesResultsArtifact = false;
    let hasResultsArtifact = false;
    let hasRunManifest = false;
    referencedRawArtifactIds.forEach((artifactId) => {
      if (seenArtifactIds.has(artifactId)) {
        issues.push(`${path}.rawArtifactIds: duplicate ${artifactId}`);
      }
      seenArtifactIds.add(artifactId);
      const rawArtifact = artifactsById.get(artifactId);
      if (!rawArtifact) {
        issues.push(`${path}.rawArtifactIds: unknown artifact ${artifactId}`);
        return;
      }
      if (rawArtifact.runId !== id) {
        issues.push(`${path}.rawArtifactIds: artifact ${artifactId} belongs to another run`);
      }
      if (rawArtifact.adapterId !== adapterId) {
        issues.push(`${path}.rawArtifactIds: artifact ${artifactId} uses another adapter`);
      }
      if (rawArtifact.kind === "lm_eval_results") {
        hasResultsArtifact = true;
        if (rawArtifact.sha256 === executionDigest) digestMatchesResultsArtifact = true;
      }
      if (rawArtifact.kind === "run_manifest") hasRunManifest = true;
    });
    if (!hasResultsArtifact) {
      issues.push(`${path}.rawArtifactIds: expected a referenced lm_eval_results artifact`);
    }
    if (!hasRunManifest) {
      issues.push(`${path}.rawArtifactIds: expected a referenced run_manifest artifact`);
    }
    if (executionDigest && !digestMatchesResultsArtifact) {
      issues.push(
        `${path}.executionArtifactDigest: must match the referenced lm_eval_results digest`,
      );
    }
    const startedAt = dateTimeAt(item.startedAt, `${path}.startedAt`, issues);
    const completedAt = dateTimeAt(item.completedAt, `${path}.completedAt`, issues);
    if (startedAt !== undefined && completedAt !== undefined && completedAt < startedAt) {
      issues.push(`${path}.completedAt: cannot precede startedAt`);
    }
    if (typeof item.comparisonEligible !== "boolean") issues.push(`${path}.comparisonEligible: expected boolean`);
    const reasons = stringArrayAt(item.comparisonEligibilityReasons, `${path}.comparisonEligibilityReasons`, issues);
    if (item.comparisonEligible === true && reasons.length > 0) issues.push(`${path}.comparisonEligibilityReasons: eligible runs cannot have exclusion reasons`);
    if (item.comparisonEligible === false && reasons.length === 0) {
      issues.push(`${path}.comparisonEligibilityReasons: ineligible runs require an exclusion reason`);
    }
  });

  for (const artifact of arrayAt(root.rawArtifacts, "$.rawArtifacts", issues)) {
    const artifactObject = artifact as JsonObject;
    if (typeof artifactObject.runId === "string" && !runIds.has(artifactObject.runId)) {
      issues.push(`$.rawArtifacts: artifact ${String(artifactObject.id)} references unknown run ${artifactObject.runId}`);
    } else if (
      typeof artifactObject.runId === "string" &&
      typeof artifactObject.id === "string" &&
      !runArtifactIdsByRunId.get(artifactObject.runId)?.has(artifactObject.id)
    ) {
      issues.push(
        `$.rawArtifacts: artifact ${artifactObject.id} is not referenced by its owning run`,
      );
    }
  }

  return { valid: issues.length === 0, issues };
}

export function parseEvaluationRegistry(input: unknown, modelRegistry?: Registry): EvaluationRegistry {
  const result = validateEvaluationRegistry(input, modelRegistry);
  if (!result.valid) throw new EvaluationValidationError(result.issues);
  return input as EvaluationRegistry;
}

export function listEvaluationRunsFromRegistry(
  registry: EvaluationRegistry,
  filters: EvaluationRunFilters = {},
): EvaluationRegistry["runs"] {
  return registry.runs.filter((run) => {
    if (filters.modelId && run.modelId !== filters.modelId) return false;
    if (filters.suite && run.benchmark.suite !== filters.suite) return false;
    if (filters.comparisonEligible !== undefined && run.comparisonEligible !== filters.comparisonEligible) return false;
    return true;
  });
}

export function listEvaluationSourcesForRunFromRegistry(
  registry: EvaluationRegistry,
  runId: string,
): EvaluationRegistry["sources"] {
  const run = registry.runs.find((candidate) => candidate.id === runId);
  if (!run) return [];
  const artifactIds = new Set(run.rawArtifactIds);
  const sourceIds = new Set(
    registry.rawArtifacts
      .filter((artifact) => artifactIds.has(artifact.id))
      .map((artifact) => artifact.sourceId),
  );
  return registry.sources.filter((source) => sourceIds.has(source.id));
}

export function listEvaluationArtifactsForRunFromRegistry(
  registry: EvaluationRegistry,
  runId: string,
): EvaluationRegistry["rawArtifacts"] {
  const run = registry.runs.find((candidate) => candidate.id === runId);
  if (!run) return [];
  const artifactIds = new Set(run.rawArtifactIds);
  return registry.rawArtifacts.filter((artifact) => artifactIds.has(artifact.id));
}
