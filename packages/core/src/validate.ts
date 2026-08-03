import type {
  Claim,
  CompatibilityRecord,
  HardwareRecord,
  ModelRecord,
  ProvenanceRef,
  Registry,
  RegistrySource,
} from "./types.js";

type JsonObject = Record<string, unknown>;

export class RegistryValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(`Registry validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}.`);
    this.name = "RegistryValidationError";
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

function exactKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issues.push(`${path}.${key}: unexpected property`);
  }
  for (const key of allowed) {
    if (!(key in value)) issues.push(`${path}.${key}: missing property`);
  }
}

function exactKeysWithOptional(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowedSet = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issues.push(`${path}.${key}: unexpected property`);
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

function positiveIntegerAt(value: unknown, path: string, issues: string[]): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    issues.push(`${path}: expected positive safe integer`);
    return 1;
  }
  return value;
}

function boundedIntegerAt(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
  issues: string[],
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    issues.push(`${path}: expected integer from ${minimum} through ${maximum}`);
    return minimum;
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

function parseProvenance(value: unknown, path: string, issues: string[]): ProvenanceRef[] {
  const values = arrayAt(value, path, issues);
  if (values.length === 0) issues.push(`${path}: expected at least one provenance reference`);
  return values.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = objectAt(entry, itemPath, issues);
    exactKeysWithOptional(item, ["sourceId"], ["locator"], itemPath, issues);
    const sourceId = stringAt(item.sourceId, `${itemPath}.sourceId`, issues);
    if (item.locator === undefined) return { sourceId };
    return { sourceId, locator: stringAt(item.locator, `${itemPath}.locator`, issues) };
  });
}

function parseClaim<T>(
  value: unknown,
  path: string,
  parseValue: (value: unknown, path: string, issues: string[]) => T,
  issues: string[],
): Claim<T> {
  const item = objectAt(value, path, issues);
  if (item.status === "known") {
    exactKeys(item, ["status", "value", "provenance"], path, issues);
    return {
      status: "known",
      value: parseValue(item.value, `${path}.value`, issues),
      provenance: parseProvenance(item.provenance, `${path}.provenance`, issues),
    };
  }
  if (item.status === "unknown") {
    exactKeys(item, ["status", "reason", "provenance"], path, issues);
    return {
      status: "unknown",
      reason: stringAt(item.reason, `${path}.reason`, issues),
      provenance: parseProvenance(item.provenance, `${path}.provenance`, issues),
    };
  }
  issues.push(`${path}.status: expected \"known\" or \"unknown\"`);
  return {
    status: "unknown",
    reason: "Invalid claim",
    provenance: [],
  };
}

function parseSource(value: unknown, path: string, issues: string[]): RegistrySource {
  const item = objectAt(value, path, issues);
  exactKeysWithOptional(
    item,
    ["id", "title", "publisher", "url", "retrievedAt"],
    ["publishedAt", "locator"],
    path,
    issues,
  );
  const url = stringAt(item.url, `${path}.url`, issues);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") issues.push(`${path}.url: expected https URL`);
  } catch {
    issues.push(`${path}.url: expected valid URL`);
  }
  const retrievedAt = stringAt(item.retrievedAt, `${path}.retrievedAt`, issues);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(retrievedAt)) {
    issues.push(`${path}.retrievedAt: expected YYYY-MM-DD date`);
  }
  const source: RegistrySource = {
    id: stringAt(item.id, `${path}.id`, issues),
    title: stringAt(item.title, `${path}.title`, issues),
    publisher: stringAt(item.publisher, `${path}.publisher`, issues),
    url,
    retrievedAt,
  };
  if (item.publishedAt !== undefined) {
    const publishedAt = stringAt(item.publishedAt, `${path}.publishedAt`, issues);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) {
      issues.push(`${path}.publishedAt: expected YYYY-MM-DD date`);
    }
    source.publishedAt = publishedAt;
  }
  if (item.locator !== undefined) {
    source.locator = stringAt(item.locator, `${path}.locator`, issues);
  }
  return source;
}

function parseModel(value: unknown, path: string, issues: string[]): ModelRecord {
  const item = objectAt(value, path, issues);
  exactKeys(item, ["id", "name", "provider", "provenance", "artifact", "claims"], path, issues);

  const artifactPath = `${path}.artifact`;
  const artifact = objectAt(item.artifact, artifactPath, issues);
  exactKeys(
    artifact,
    ["repository", "revision", "format", "manifestUrl", "provenance"],
    artifactPath,
    issues,
  );
  const revision = stringAt(artifact.revision, `${artifactPath}.revision`, issues);
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    issues.push(`${artifactPath}.revision: expected pinned 40-character lowercase commit hash`);
  }
  const format = stringAt(artifact.format, `${artifactPath}.format`, issues);
  if (format !== "safetensors") issues.push(`${artifactPath}.format: expected \"safetensors\"`);
  const manifestUrl = stringAt(artifact.manifestUrl, `${artifactPath}.manifestUrl`, issues);
  try {
    const parsed = new URL(manifestUrl);
    if (parsed.protocol !== "https:") issues.push(`${artifactPath}.manifestUrl: expected https URL`);
    if (!manifestUrl.includes(revision)) {
      issues.push(`${artifactPath}.manifestUrl: expected immutable URL containing the pinned revision`);
    }
  } catch {
    issues.push(`${artifactPath}.manifestUrl: expected valid URL`);
  }

  const claimsPath = `${path}.claims`;
  const claims = objectAt(item.claims, claimsPath, issues);
  const claimKeys = [
    "totalParameters",
    "activeParameters",
    "artifactTensorBytes",
    "contextTokens",
    "routedExperts",
    "expertsPerToken",
    "nativeWeightFormat",
    "license",
  ] as const;
  exactKeys(claims, claimKeys, claimsPath, issues);

  const model: ModelRecord = {
    id: stringAt(item.id, `${path}.id`, issues),
    name: stringAt(item.name, `${path}.name`, issues),
    provider: stringAt(item.provider, `${path}.provider`, issues),
    provenance: parseProvenance(item.provenance, `${path}.provenance`, issues),
    artifact: {
      repository: stringAt(artifact.repository, `${artifactPath}.repository`, issues),
      revision,
      format: "safetensors",
      manifestUrl,
      provenance: parseProvenance(artifact.provenance, `${artifactPath}.provenance`, issues),
    },
    claims: {
      totalParameters: parseClaim(claims.totalParameters, `${claimsPath}.totalParameters`, positiveIntegerAt, issues),
      activeParameters: parseClaim(claims.activeParameters, `${claimsPath}.activeParameters`, positiveIntegerAt, issues),
      artifactTensorBytes: parseClaim(claims.artifactTensorBytes, `${claimsPath}.artifactTensorBytes`, positiveIntegerAt, issues),
      contextTokens: parseClaim(claims.contextTokens, `${claimsPath}.contextTokens`, positiveIntegerAt, issues),
      routedExperts: parseClaim(claims.routedExperts, `${claimsPath}.routedExperts`, positiveIntegerAt, issues),
      expertsPerToken: parseClaim(claims.expertsPerToken, `${claimsPath}.expertsPerToken`, positiveIntegerAt, issues),
      nativeWeightFormat: parseClaim(claims.nativeWeightFormat, `${claimsPath}.nativeWeightFormat`, stringAt, issues),
      license: parseClaim(claims.license, `${claimsPath}.license`, stringAt, issues),
    },
  };

  if (
    model.claims.totalParameters.status === "known" &&
    model.claims.activeParameters.status === "known" &&
    model.claims.activeParameters.value > model.claims.totalParameters.value
  ) {
    issues.push(`${claimsPath}.activeParameters.value: cannot exceed totalParameters`);
  }
  if (
    model.claims.routedExperts.status === "known" &&
    model.claims.expertsPerToken.status === "known" &&
    model.claims.expertsPerToken.value > model.claims.routedExperts.value
  ) {
    issues.push(`${claimsPath}.expertsPerToken.value: cannot exceed routedExperts`);
  }
  return model;
}

function parseCompatibility(
  value: unknown,
  path: string,
  issues: string[],
): CompatibilityRecord {
  const item = objectAt(value, path, issues);
  exactKeys(
    item,
    ["id", "modelId", "hardwareId", "framework", "status", "evidenceLevel", "reason", "provenance"],
    path,
    issues,
  );
  const status = stringAt(item.status, `${path}.status`, issues);
  if (!["supported", "unsupported", "unknown"].includes(status)) {
    issues.push(`${path}.status: expected supported, unsupported, or unknown`);
  }
  const evidenceLevel = stringAt(item.evidenceLevel, `${path}.evidenceLevel`, issues);
  const evidenceLevels = [
    "owner_declared",
    "runtime_implemented",
    "reproduced",
    "known_issue",
    "unsupported",
    "unknown",
  ];
  if (!evidenceLevels.includes(evidenceLevel)) {
    issues.push(
      `${path}.evidenceLevel: expected owner_declared, runtime_implemented, reproduced, known_issue, unsupported, or unknown`,
    );
  }
  if (status === "unknown" && !["unknown", "known_issue"].includes(evidenceLevel)) {
    issues.push(`${path}.evidenceLevel: unknown status requires unknown or known_issue evidence`);
  }
  if (
    status === "supported" &&
    !["owner_declared", "runtime_implemented", "reproduced"].includes(evidenceLevel)
  ) {
    issues.push(`${path}.evidenceLevel: supported status requires positive support evidence`);
  }
  if (status === "unsupported" && evidenceLevel !== "unsupported") {
    issues.push(`${path}.evidenceLevel: unsupported status requires unsupported evidence`);
  }
  return {
    id: stringAt(item.id, `${path}.id`, issues),
    modelId: stringAt(item.modelId, `${path}.modelId`, issues),
    hardwareId: stringAt(item.hardwareId, `${path}.hardwareId`, issues),
    framework: stringAt(item.framework, `${path}.framework`, issues),
    status: ["supported", "unsupported", "unknown"].includes(status)
      ? (status as CompatibilityRecord["status"])
      : "unknown",
    evidenceLevel: evidenceLevels.includes(evidenceLevel)
      ? (evidenceLevel as CompatibilityRecord["evidenceLevel"])
      : "unknown",
    reason: stringAt(item.reason, `${path}.reason`, issues),
    provenance: parseProvenance(item.provenance, `${path}.provenance`, issues),
  };
}

function parseHardware(value: unknown, path: string, issues: string[]): HardwareRecord {
  const item = objectAt(value, path, issues);
  exactKeys(item, ["id", "name", "vendor", "aliases", "provenance", "claims"], path, issues);
  const aliases = arrayAt(item.aliases, `${path}.aliases`, issues).map((alias, index) =>
    stringAt(alias, `${path}.aliases[${index}]`, issues),
  );
  if (aliases.length === 0) issues.push(`${path}.aliases: expected at least one alias`);
  const claimsPath = `${path}.claims`;
  const claims = objectAt(item.claims, claimsPath, issues);
  exactKeys(claims, ["memoryGigabytes"], claimsPath, issues);
  return {
    id: stringAt(item.id, `${path}.id`, issues),
    name: stringAt(item.name, `${path}.name`, issues),
    vendor: stringAt(item.vendor, `${path}.vendor`, issues),
    aliases,
    provenance: parseProvenance(item.provenance, `${path}.provenance`, issues),
    claims: {
      memoryGigabytes: parseClaim(
        claims.memoryGigabytes,
        `${claimsPath}.memoryGigabytes`,
        positiveIntegerAt,
        issues,
      ),
    },
  };
}

function checkUniqueIds(values: readonly { id: string }[], path: string, issues: string[]): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id)) issues.push(`${path}[${index}].id: duplicate id \"${value.id}\"`);
    seen.add(value.id);
  });
}

function checkProvenance(
  registry: Registry,
  issues: string[],
): void {
  const sourceIds = new Set(registry.sources.map((source) => source.id));
  const check = (refs: readonly ProvenanceRef[], path: string): void => {
    refs.forEach((ref, index) => {
      if (!sourceIds.has(ref.sourceId)) {
        issues.push(`${path}[${index}].sourceId: unknown source \"${ref.sourceId}\"`);
      }
    });
  };
  registry.models.forEach((model, index) => {
    const base = `$.models[${index}]`;
    check(model.provenance, `${base}.provenance`);
    check(model.artifact.provenance, `${base}.artifact.provenance`);
    for (const [key, claim] of Object.entries(model.claims)) {
      check(claim.provenance, `${base}.claims.${key}.provenance`);
    }
  });
  registry.hardware.forEach((hardware, index) => {
    const base = `$.hardware[${index}]`;
    check(hardware.provenance, `${base}.provenance`);
    check(hardware.claims.memoryGigabytes.provenance, `${base}.claims.memoryGigabytes.provenance`);
  });
  registry.compatibility.forEach((record, index) => {
    check(record.provenance, `$.compatibility[${index}].provenance`);
  });
}

export function parseRegistry(input: unknown): Registry {
  const issues: string[] = [];
  const root = objectAt(input, "$", issues);
  exactKeys(
    root,
    ["$schema", "registryVersion", "generatedAt", "methodology", "sources", "models", "hardware", "compatibility"],
    "$",
    issues,
  );
  const methodologyPath = "$.methodology";
  const methodology = objectAt(root.methodology, methodologyPath, issues);
  exactKeys(
    methodology,
    ["capacityUnit", "defaultReserveBasisPoints", "defaultAcceleratorsPerNode"],
    methodologyPath,
    issues,
  );

  const registryVersion = stringAt(root.registryVersion, "$.registryVersion", issues);
  if (registryVersion !== "1.0.0") issues.push('$.registryVersion: expected "1.0.0"');
  const generatedAt = stringAt(root.generatedAt, "$.generatedAt", issues);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(generatedAt)) issues.push("$.generatedAt: expected YYYY-MM-DD date");
  const capacityUnit = stringAt(methodology.capacityUnit, `${methodologyPath}.capacityUnit`, issues);
  if (capacityUnit !== "decimal-gigabytes") {
    issues.push(`${methodologyPath}.capacityUnit: expected \"decimal-gigabytes\"`);
  }

  const sources = arrayAt(root.sources, "$.sources", issues).map((value, index) =>
    parseSource(value, `$.sources[${index}]`, issues),
  );
  const models = arrayAt(root.models, "$.models", issues).map((value, index) =>
    parseModel(value, `$.models[${index}]`, issues),
  );
  const hardware = arrayAt(root.hardware, "$.hardware", issues).map((value, index) =>
    parseHardware(value, `$.hardware[${index}]`, issues),
  );
  const compatibility = arrayAt(root.compatibility, "$.compatibility", issues).map((value, index) =>
    parseCompatibility(value, `$.compatibility[${index}]`, issues),
  );
  if (sources.length === 0) issues.push("$.sources: expected at least one source");
  if (models.length === 0) issues.push("$.models: expected at least one model");
  if (hardware.length === 0) issues.push("$.hardware: expected at least one hardware record");
  if (compatibility.length === 0) issues.push("$.compatibility: expected at least one compatibility record");

  const registry: Registry = {
    $schema: stringAt(root.$schema, "$.$schema", issues),
    registryVersion: "1.0.0",
    generatedAt,
    methodology: {
      capacityUnit: "decimal-gigabytes",
      defaultReserveBasisPoints: boundedIntegerAt(
        methodology.defaultReserveBasisPoints,
        0,
        9999,
        `${methodologyPath}.defaultReserveBasisPoints`,
        issues,
      ),
      defaultAcceleratorsPerNode: positiveIntegerAt(
        methodology.defaultAcceleratorsPerNode,
        `${methodologyPath}.defaultAcceleratorsPerNode`,
        issues,
      ),
    },
    sources,
    models,
    hardware,
    compatibility,
  };
  checkUniqueIds(sources, "$.sources", issues);
  checkUniqueIds(models, "$.models", issues);
  checkUniqueIds(hardware, "$.hardware", issues);
  checkUniqueIds(compatibility, "$.compatibility", issues);
  const modelIds = new Set(models.map((model) => model.id));
  const hardwareIds = new Set(hardware.map((item) => item.id));
  compatibility.forEach((record, index) => {
    if (!modelIds.has(record.modelId)) {
      issues.push(`$.compatibility[${index}].modelId: unknown model \"${record.modelId}\"`);
    }
    if (!hardwareIds.has(record.hardwareId)) {
      issues.push(`$.compatibility[${index}].hardwareId: unknown hardware \"${record.hardwareId}\"`);
    }
  });
  checkProvenance(registry, issues);

  if (issues.length > 0) throw new RegistryValidationError(issues);
  return registry;
}

export function validateRegistry(input: unknown):
  | { valid: true; registry: Registry; issues: readonly [] }
  | { valid: false; issues: readonly string[] } {
  try {
    return { valid: true, registry: parseRegistry(input), issues: [] };
  } catch (error) {
    if (error instanceof RegistryValidationError) {
      return { valid: false, issues: error.issues };
    }
    throw error;
  }
}
