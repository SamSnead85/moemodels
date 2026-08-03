import type {
  EvaluationAdapter,
  EvaluationSource,
  NormalizedEvaluationRun,
  RawEvaluationArtifact,
  Registry,
  ReportedBenchmarkClaim,
  ResidencyFit,
} from "@moemodels/core";

export type ArtifactAssociation = "artifact_snapshot_associated" | "model_name_only";
export type AvailabilityTarget = "single" | "ha";

export interface FitRequest {
  model: string;
  hardware: string;
  devices?: number;
  devicesPerNode?: number;
  reserveBps?: number;
}

export interface FitResponse {
  apiVersion: "v1";
  registryVersion: Registry["registryVersion"];
  model: {
    id: string;
    name: string;
    repository: string;
    revision: string;
  };
  hardware: {
    id: string;
    name: string;
  };
  input: {
    devices: number;
    devicesPerNode: number;
    reserveBps: number;
  };
  /** A calculated checkpoint-tensor residency lower bound, not measured runtime performance. */
  fit: ResidencyFit;
}

export interface EvaluationFilters {
  model?: string;
  suite?: string;
  artifactAssociation?: ArtifactAssociation;
}

export interface EvaluationsResponse {
  apiVersion: "v1";
  evaluationSchemaVersion: "1.0.0";
  schemaUrl: string;
  generatedAt: string;
  filters: {
    model: string | null;
    suite: string | null;
    artifactAssociation: ArtifactAssociation | null;
  };
  counts: {
    reportedClaims: number;
    normalizedRuns: number;
    comparisonEligibleRuns: number;
  };
  adapters: EvaluationAdapter[];
  sources: EvaluationSource[];
  reportedClaims: ReportedBenchmarkClaim[];
  rawArtifacts: RawEvaluationArtifact[];
  runs: NormalizedEvaluationRun[];
}

export type EvaluationDetailResponse =
  | {
      apiVersion: "v1";
      evaluationSchemaVersion: "1.0.0";
      kind: "owner_reported_claim";
      record: ReportedBenchmarkClaim;
      sources: EvaluationSource[];
      rawArtifacts: [];
    }
  | {
      apiVersion: "v1";
      evaluationSchemaVersion: "1.0.0";
      kind: "normalized_run";
      record: NormalizedEvaluationRun;
      sources: EvaluationSource[];
      rawArtifacts: RawEvaluationArtifact[];
    };

export interface PlanRequest extends FitRequest {
  runtime?: string;
  inputTokens?: number;
  outputTokens?: number;
  concurrency?: number;
  targetTtftMs?: number;
  targetInterTokenMs?: number;
  availability?: AvailabilityTarget;
}

export type PlanSection = Record<string, unknown>;

/**
 * Stable outer envelope for the v1 deployment-validation plan. Sections remain
 * open records while the planning contract matures so additive server fields do
 * not force a client upgrade.
 */
export interface DeploymentValidationPlan {
  kind: "deployment_validation_plan";
  schemaVersion: "1.0.0";
  scenarioKey: string;
  artifact: PlanSection;
  target: PlanSection;
  workload: PlanSection;
  evidencePolicy: PlanSection;
  readiness: PlanSection;
  dimensions: PlanSection;
  risks: unknown[];
  validationGates: unknown[];
  nextAction: unknown;
  reproducibility: PlanSection;
  [key: string]: unknown;
}

export interface PlanResponse {
  apiVersion: "v1";
  registryVersion: Registry["registryVersion"];
  /** A validation plan with explicit unknowns; it is not measured certification. */
  plan: DeploymentValidationPlan;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export type { Registry } from "@moemodels/core";
