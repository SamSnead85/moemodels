import type { ProvenanceRef } from "./types.js";

export type EvaluationEvidenceClass = "sourced" | "measured" | "calculated";

export interface KnownEvaluationClaim<T> {
  status: "known";
  value: T;
  evidenceClass: EvaluationEvidenceClass;
  provenance: ProvenanceRef[];
}

export interface UnknownEvaluationClaim {
  status: "unknown";
  reason: string;
  provenance: ProvenanceRef[];
}

export type EvaluationClaim<T> = KnownEvaluationClaim<T> | UnknownEvaluationClaim;

export interface EvaluationSource {
  id: string;
  title: string;
  publisher: string;
  url: string;
  retrievedAt: string;
  publishedAt?: string;
  locator?: string;
  license?: string;
  licenseLocator?: string;
  sourceType:
    | "official_model_card"
    | "technical_report"
    | "adapter_repository"
    | "evaluation_artifact";
  artifactSnapshot?: {
    repository: string;
    revision: string;
  };
}

export interface EvaluationAdapter {
  id: string;
  name: string;
  kind: "lm_eval";
  packageName: "lm-eval";
  version: "0.4.12";
  repositoryUrl: string;
  revision: string;
  revisionUrl: string;
  status: "pinned_not_executed";
  sourceIds: string[];
}

export interface RawEvaluationArtifact {
  id: string;
  runId: string;
  adapterId: string;
  sourceId: string;
  kind: "lm_eval_results" | "lm_eval_samples" | "run_manifest";
  mediaType: string;
  uri: string;
  sha256: string;
  byteLength: number;
}

export interface EvaluationMetric {
  sourceKey: string;
  name: string;
  filter: EvaluationClaim<string>;
  value: EvaluationClaim<number>;
  standardError: EvaluationClaim<number>;
  higherIsBetter: EvaluationClaim<boolean>;
  sampleCount: EvaluationClaim<number>;
}

export interface EvaluationTaskResult {
  name: string;
  alias: EvaluationClaim<string>;
  version: EvaluationClaim<string>;
  datasetPath: EvaluationClaim<string>;
  datasetRevision: EvaluationClaim<string>;
  taskHash: EvaluationClaim<string>;
  fewShot: EvaluationClaim<number>;
  originalSamples: EvaluationClaim<number>;
  effectiveSamples: EvaluationClaim<number>;
  metrics: EvaluationMetric[];
}

export interface EvaluationGroupResult {
  name: string;
  taskNames: string[];
  metrics: EvaluationMetric[];
}

export interface IngestionDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  locator?: string;
}

export interface EvaluationRun {
  id: string;
  adapter: {
    name: "lm-eval";
    version: "0.1.0";
    inputFamily: "legacy" | "modern-v0.4";
  };
  publicationStatus: "eligible" | "incomplete" | "fixture_only" | "withdrawn";
  rawArtifactIds: string[];
  model: {
    registryModelId: EvaluationClaim<string>;
    repository: EvaluationClaim<string>;
    revision: EvaluationClaim<string>;
    binding: "artifact_hash_match" | "unresolved";
  };
  harness: {
    name: "lm-evaluation-harness";
    version: EvaluationClaim<string>;
    gitRevision: EvaluationClaim<string>;
    revisionCompleteness: "full" | "abbreviated" | "unknown";
  };
  execution: {
    executedAt: EvaluationClaim<string>;
    durationSeconds: EvaluationClaim<string>;
    backend: EvaluationClaim<string>;
    runtimeVersion: EvaluationClaim<string>;
    device: EvaluationClaim<string>;
    hardwareTopology: EvaluationClaim<string>;
    dtype: EvaluationClaim<string>;
    quantization: EvaluationClaim<string | null>;
    batchSize: EvaluationClaim<string>;
    limit: EvaluationClaim<number | null>;
    seeds: EvaluationClaim<{
      random: number;
      numpy: number;
      torch: number;
      fewshot: number;
    }>;
    chatTemplateSha256: EvaluationClaim<string | null>;
    systemInstructionSha256: EvaluationClaim<string | null>;
    generationConfig: EvaluationClaim<Record<string, unknown> | null>;
  };
  tasks: EvaluationTaskResult[];
  groups: EvaluationGroupResult[];
  diagnostics: IngestionDiagnostic[];
  eligibility: {
    status: "eligible" | "insufficient";
    missing: string[];
  };
}

export interface ReportedBenchmarkClaim {
  id: string;
  claimType: "owner_reported";
  modelId: string;
  modelName: string;
  owner: string;
  artifact: {
    repository: string;
    revision: string;
  };
  artifactAssociation: "artifact_snapshot_associated" | "model_name_only";
  executionArtifactDigest: null;
  benchmark: {
    suite: string;
    version: string | null;
    subset: string | null;
  };
  metric: {
    name: string;
    value: number;
    unit: "reported_score" | "percentage_points";
    scale: string | null;
    direction: "higher_is_better" | "lower_is_better";
  };
  evaluation: {
    mode: string;
    reportedSettings: Array<{
      name: string;
      value: string | number | boolean | null;
    }>;
  };
  sourceRefs: Array<{
    sourceId: string;
    locator: string;
  }>;
  comparisonEligible: false;
  missingContext: string[];
}

export interface NormalizedEvaluationRun {
  id: string;
  runType: "normalized";
  adapterId: string;
  modelId: string;
  artifact: {
    repository: string;
    revision: string;
  };
  executionArtifactDigest: string;
  benchmark: {
    suite: string;
    version: string | null;
    subset: string | null;
  };
  metrics: Array<{
    sourceKey: string;
    name: string;
    filter: string;
    value: number;
    standardError: number;
    sampleCount: number;
    unit: string;
    direction: "higher_is_better" | "lower_is_better";
  }>;
  settings: Array<{
    name: string;
    value: string | number | boolean | null;
  }>;
  fingerprint: {
    canonicalization: {
      scheme: "RFC8785";
      textEncoding: "UTF-8";
      absentValue: "JSON null";
      hardwareRegistryVersion: "1.0.0";
    };
    harness: {
      name: string;
      version: string;
      revision: string;
    };
    task: {
      hash: string;
      version: string;
      datasetRevision: string;
    };
    chatTemplateSha256: string;
    systemPromptSha256: string;
    reasoningConfigSha256: string;
    samplingConfigSha256: string;
    seeds: {
      random: number;
      numpy: number;
      torch: number;
      fewshot: number;
    };
    samples: {
      original: number;
      effective: number;
      limit: number | null;
      repetitions: number;
    };
    runtime: {
      name: string;
      version: string;
      precision: string;
    };
    hardware: {
      acceleratorId: string;
      acceleratorCount: number;
      nodeCount: number;
      devicesPerNode: number;
      interconnect: string;
    };
  };
  rawArtifactIds: string[];
  startedAt: string;
  completedAt: string;
  comparisonEligible: boolean;
  comparisonEligibilityReasons: string[];
}

export interface EvaluationRegistry {
  $schema: string;
  schemaVersion: "1.0.0";
  generatedAt: string;
  sources: EvaluationSource[];
  adapters: EvaluationAdapter[];
  reportedClaims: ReportedBenchmarkClaim[];
  rawArtifacts: RawEvaluationArtifact[];
  runs: NormalizedEvaluationRun[];
}

export interface EvaluationRunFilters {
  modelId?: string;
  suite?: string;
  comparisonEligible?: boolean;
}
