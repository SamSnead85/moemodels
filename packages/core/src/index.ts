import rawRegistry from "@moemodels/registry-v1" with { type: "json" };
import rawEvaluationRegistry from "@moemodels/evaluations-v1" with { type: "json" };

import {
  listEvaluationArtifactsForRunFromRegistry,
  listEvaluationRunsFromRegistry,
  listEvaluationSourcesForRunFromRegistry,
  parseEvaluationRegistry,
} from "./evaluation-validate.js";
import { parseRegistry } from "./validate.js";

export * from "./evaluation-types.js";
export * from "./evaluation-validate.js";
export * from "./plan.js";
export * from "./residency.js";
export * from "./types.js";
export * from "./validate.js";

/**
 * Browser-safe static registry. Importing this module performs no filesystem,
 * network, or environment access; bundlers include the versioned JSON asset.
 */
export const registry = parseRegistry(rawRegistry);
export const evaluationRegistry = parseEvaluationRegistry(rawEvaluationRegistry, registry);

export function findModel(query: string) {
  const normalized = query.trim().toLowerCase();
  return registry.models.find(
    (model) =>
      model.id.toLowerCase() === normalized ||
      model.name.toLowerCase() === normalized ||
      model.artifact.repository.toLowerCase() === normalized,
  );
}

export function findHardware(query: string) {
  const normalized = query.trim().toLowerCase();
  return registry.hardware.find(
    (hardware) =>
      hardware.id.toLowerCase() === normalized ||
      hardware.name.toLowerCase() === normalized ||
      hardware.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
}

export function findEvaluationRun(id: string) {
  return evaluationRegistry.runs.find((run) => run.id === id);
}

export function listEvaluationRuns(
  filters: Parameters<typeof listEvaluationRunsFromRegistry>[1] = {},
) {
  return listEvaluationRunsFromRegistry(evaluationRegistry, filters);
}

export function listReportedBenchmarkClaims(modelId?: string) {
  return evaluationRegistry.reportedClaims.filter(
    (claim) => modelId === undefined || claim.modelId === modelId,
  );
}

export function listEvaluationSourcesForRun(id: string) {
  return listEvaluationSourcesForRunFromRegistry(evaluationRegistry, id);
}

export function listEvaluationArtifactsForRun(id: string) {
  return listEvaluationArtifactsForRunFromRegistry(evaluationRegistry, id);
}
