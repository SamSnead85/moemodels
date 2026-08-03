import {
  buildDeploymentPlan,
  calculateResidencyFit,
  evaluationRegistry,
  findHardware,
  findModel,
  registry,
  type ModelRecord,
} from "@moemodels/core";

type JsonObject = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: false;
  };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "search_models",
    title: "Search exact model records",
    description:
      "Search the versioned MOEModels registry. Returned architecture and artifact fields are sourced facts or explicit unknowns, not measured performance.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Optional name, provider, id, or repository search." },
        provider: { type: "string", description: "Optional provider substring." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "compare_sourced_model_properties",
    title: "Compare sourced static properties",
    description:
      "Place exact model artifact and architecture claims side by side. This does not rank quality, benchmark performance, runtime support, or economics.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["models"],
      properties: {
        models: {
          type: "array",
          minItems: 2,
          maxItems: 10,
          uniqueItems: true,
          items: { type: "string" },
          description: "Model ids, names, or canonical repositories.",
        },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "calculate_static_checkpoint_fit",
    title: "Calculate a checkpoint residency lower bound",
    description:
      "Calculate whether pinned checkpoint tensor bytes fit within advertised accelerator memory after a declared reserve. This is calculated evidence, not a runtime load test or measured VRAM result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["model", "hardware"],
      properties: {
        model: { type: "string" },
        hardware: { type: "string" },
        accelerators: { type: "integer", minimum: 1, maximum: 4096, default: 8 },
        acceleratorsPerNode: { type: "integer", minimum: 1, maximum: 256, default: 8 },
        reserveBasisPoints: { type: "integer", minimum: 0, maximum: 9999, default: 1300 },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "summarize_evaluation_evidence",
    title: "Summarize evaluation evidence",
    description:
      "Summarize owner-reported claims and normalized runs while preserving their evidence class and comparison eligibility. Owner-reported scores are never presented as MOEModels measurements.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        model: { type: "string", description: "Optional exact registry model query." },
        suite: { type: "string", description: "Optional case-insensitive benchmark suite substring." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "export_deployment_validation_plan",
    title: "Export a deployment validation plan",
    description:
      "Build a reproducible validation plan for an exact artifact, hardware target, workload, and SLA. The plan exposes a calculated static floor and required measurement gates; it is not deployment certification.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["model", "hardware"],
      properties: {
        model: { type: "string" },
        hardware: { type: "string" },
        accelerators: { type: "integer", minimum: 1, maximum: 4096, default: 8 },
        acceleratorsPerNode: { type: "integer", minimum: 1, maximum: 256, default: 8 },
        reserveBasisPoints: { type: "integer", minimum: 0, maximum: 9999, default: 1300 },
        runtime: { type: "string", default: "unspecified" },
        inputTokens: { type: "integer", minimum: 1, default: 4096 },
        outputTokens: { type: "integer", minimum: 1, default: 1024 },
        concurrency: { type: "integer", minimum: 1, default: 1 },
        targetTtftMs: { type: "integer", minimum: 1, default: 1000 },
        targetInterTokenMs: { type: "integer", minimum: 1, default: 50 },
        availability: { type: "string", enum: ["single", "ha"], default: "single" },
      },
    },
    annotations: READ_ONLY,
  },
] as const;

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

function objectInput(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolInputError("Tool arguments must be a JSON object.");
  }
  return value as JsonObject;
}

function requiredString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolInputError(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolInputError(`${key} must be a non-empty string when provided.`);
  }
  return value.trim();
}

function integer(
  input: JsonObject,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = input[key] ?? fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ToolInputError(`${key} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function resolveModel(query: string): ModelRecord {
  const model = findModel(query);
  if (!model) {
    throw new ToolInputError(
      `Unknown model “${query}”. Available ids: ${registry.models.map((item) => item.id).join(", ")}.`,
    );
  }
  return model;
}

function resolveHardware(query: string) {
  const hardware = findHardware(query);
  if (!hardware) {
    throw new ToolInputError(
      `Unknown hardware “${query}”. Available ids: ${registry.hardware.map((item) => item.id).join(", ")}.`,
    );
  }
  return hardware;
}

function modelSummary(model: ModelRecord) {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    artifact: model.artifact,
    claims: model.claims,
  };
}

function searchModels(argumentsValue: unknown) {
  const input = objectInput(argumentsValue);
  const query = optionalString(input, "query")?.toLowerCase();
  const provider = optionalString(input, "provider")?.toLowerCase();
  const limit = integer(input, "limit", 20, 1, 50);
  const matches = registry.models.filter((model) => {
    const matchesQuery =
      query === undefined ||
      [model.id, model.name, model.provider, model.artifact.repository].some((value) =>
        value.toLowerCase().includes(query),
      );
    const matchesProvider =
      provider === undefined || model.provider.toLowerCase().includes(provider);
    return matchesQuery && matchesProvider;
  });
  return {
    registryVersion: registry.registryVersion,
    evidenceClass: "sourced_or_unknown",
    matched: matches.length,
    returned: Math.min(matches.length, limit),
    models: matches.slice(0, limit).map(modelSummary),
  };
}

function compareModels(argumentsValue: unknown) {
  const input = objectInput(argumentsValue);
  const values = input.models;
  if (!Array.isArray(values) || values.length < 2 || values.length > 10) {
    throw new ToolInputError("models must contain between 2 and 10 model queries.");
  }
  if (values.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new ToolInputError("Every models entry must be a non-empty string.");
  }
  const models = values.map((value) => resolveModel(String(value)));
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new ToolInputError("models must resolve to distinct registry records.");
  }
  return {
    registryVersion: registry.registryVersion,
    evidenceClass: "sourced_or_unknown",
    comparisonPolicy:
      "Static properties are shown side by side. No benchmark, quality, runtime, cost, or deployment ranking is inferred.",
    models: models.map(modelSummary),
  };
}

function calculateFit(argumentsValue: unknown) {
  const input = objectInput(argumentsValue);
  const model = resolveModel(requiredString(input, "model"));
  const hardware = resolveHardware(requiredString(input, "hardware"));
  const accelerators = integer(input, "accelerators", 8, 1, 4096);
  const acceleratorsPerNode = integer(input, "acceleratorsPerNode", 8, 1, 256);
  const reserveBasisPoints = integer(input, "reserveBasisPoints", 1300, 0, 9999);
  return {
    registryVersion: registry.registryVersion,
    evidenceClass: "calculated",
    model: {
      id: model.id,
      repository: model.artifact.repository,
      revision: model.artifact.revision,
    },
    hardware: { id: hardware.id, name: hardware.name },
    input: { accelerators, acceleratorsPerNode, reserveBasisPoints },
    fit: calculateResidencyFit(model, hardware, {
      requestedAccelerators: accelerators,
      acceleratorsPerNode,
      reserveBasisPoints,
    }),
    policy:
      "Checkpoint tensor residency only. Runtime allocations, compatibility, latency, throughput, quality, and economics are not measured or predicted.",
  };
}

function summarizeEvidence(argumentsValue: unknown) {
  const input = objectInput(argumentsValue);
  const modelQuery = optionalString(input, "model");
  const model = modelQuery === undefined ? undefined : resolveModel(modelQuery);
  const suite = optionalString(input, "suite")?.toLowerCase();
  const limit = integer(input, "limit", 25, 1, 100);
  const reportedClaims = evaluationRegistry.reportedClaims.filter(
    (claim) =>
      (model === undefined || claim.modelId === model.id) &&
      (suite === undefined || claim.benchmark.suite.toLowerCase().includes(suite)),
  );
  const normalizedRuns = evaluationRegistry.runs.filter(
    (run) =>
      (model === undefined || run.modelId === model.id) &&
      (suite === undefined || run.benchmark.suite.toLowerCase().includes(suite)),
  );
  const returnedClaims = reportedClaims.slice(0, limit);
  const returnedRuns = normalizedRuns.slice(0, limit);
  const sourceIds = new Set([
    ...returnedClaims.flatMap((claim) => claim.sourceRefs.map((reference) => reference.sourceId)),
    ...returnedRuns.flatMap((run) => {
      const artifactIds = new Set(run.rawArtifactIds);
      return evaluationRegistry.rawArtifacts
        .filter((artifact) => artifactIds.has(artifact.id))
        .map((artifact) => artifact.sourceId);
    }),
  ]);
  return {
    evaluationSchemaVersion: evaluationRegistry.schemaVersion,
    evidencePolicy:
      "Owner-reported claims are sourced signals and never comparison eligible. Only normalized runs with complete fingerprints may be compared.",
    filters: { modelId: model?.id ?? null, suite: suite ?? null },
    counts: {
      ownerReportedClaims: reportedClaims.length,
      normalizedRuns: normalizedRuns.length,
      comparisonEligibleRuns: normalizedRuns.filter((run) => run.comparisonEligible).length,
    },
    truncated: reportedClaims.length > limit || normalizedRuns.length > limit,
    ownerReportedClaims: returnedClaims,
    normalizedRuns: returnedRuns,
    sources: evaluationRegistry.sources.filter((source) => sourceIds.has(source.id)),
  };
}

function exportPlan(argumentsValue: unknown) {
  const input = objectInput(argumentsValue);
  const model = resolveModel(requiredString(input, "model"));
  const hardware = resolveHardware(requiredString(input, "hardware"));
  const accelerators = integer(input, "accelerators", 8, 1, 4096);
  const acceleratorsPerNode = integer(input, "acceleratorsPerNode", 8, 1, 256);
  const reserveBasisPoints = integer(input, "reserveBasisPoints", 1300, 0, 9999);
  const inputTokens = integer(input, "inputTokens", 4096, 1, Number.MAX_SAFE_INTEGER);
  const outputTokens = integer(input, "outputTokens", 1024, 1, Number.MAX_SAFE_INTEGER);
  const concurrency = integer(input, "concurrency", 1, 1, Number.MAX_SAFE_INTEGER);
  const targetTtftMs = integer(input, "targetTtftMs", 1000, 1, Number.MAX_SAFE_INTEGER);
  const targetInterTokenMs = integer(
    input,
    "targetInterTokenMs",
    50,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const runtime = optionalString(input, "runtime");
  const availabilityValue = input.availability ?? "single";
  if (availabilityValue !== "single" && availabilityValue !== "ha") {
    throw new ToolInputError("availability must be single or ha.");
  }

  return buildDeploymentPlan({
    model,
    hardware,
    compatibility: registry.compatibility,
    requestedAccelerators: accelerators,
    acceleratorsPerNode,
    reserveBasisPoints,
    ...(runtime === undefined ? {} : { runtime }),
    workload: {
      inputTokens,
      outputTokens,
      concurrency,
      targetTtftMs,
      targetInterTokenMs,
      availability: availabilityValue,
    },
  });
}

export function callTool(name: string, argumentsValue: unknown): JsonObject {
  switch (name) {
    case "search_models":
      return searchModels(argumentsValue);
    case "compare_sourced_model_properties":
      return compareModels(argumentsValue);
    case "calculate_static_checkpoint_fit":
      return calculateFit(argumentsValue);
    case "summarize_evaluation_evidence":
      return summarizeEvidence(argumentsValue);
    case "export_deployment_validation_plan":
      return exportPlan(argumentsValue) as unknown as JsonObject;
    default:
      throw new ToolInputError(`Unknown tool “${name}”.`);
  }
}
