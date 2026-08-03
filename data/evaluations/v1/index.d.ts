export type SourceType =
  | "official_model_card"
  | "technical_report"
  | "adapter_repository"
  | "evaluation_artifact";

export type ArtifactAssociation =
  | "artifact_snapshot_associated"
  | "model_name_only";

export type MetricUnit = "reported_score" | "percentage_points";

export type SettingValue = string | number | boolean | null;

export interface ArtifactIdentity {
  repository: string;
  revision: string;
}

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
  sourceType: SourceType;
  artifactSnapshot?: ArtifactIdentity;
}

export interface EvaluationAdapter {
  id: string;
  name: string;
  kind: "lm_eval";
  packageName: "lm-eval";
  version: string;
  repositoryUrl: string;
  revision: string;
  revisionUrl: string;
  status: "pinned_not_executed";
  sourceIds: string[];
}

export interface BenchmarkDescriptor {
  suite: string;
  version: string | null;
  subset: string | null;
}

export interface ReportedMetric {
  name: string;
  value: number;
  unit: MetricUnit;
  scale: string | null;
  direction: "higher_is_better" | "lower_is_better";
}

export interface EvaluationSetting {
  name: string;
  value: SettingValue;
}

export interface EvaluationContext {
  mode: string;
  reportedSettings: EvaluationSetting[];
}

export interface SourceReference {
  sourceId: string;
  locator: string;
}

export interface OwnerReportedClaim {
  id: string;
  claimType: "owner_reported";
  modelId: string;
  modelName: string;
  owner: string;
  artifact: ArtifactIdentity;
  artifactAssociation: ArtifactAssociation;
  executionArtifactDigest: null;
  benchmark: BenchmarkDescriptor;
  metric: ReportedMetric;
  evaluation: EvaluationContext;
  sourceRefs: SourceReference[];
  comparisonEligible: false;
  missingContext: string[];
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

export interface NormalizedMetric {
  name: string;
  sourceKey: string;
  filter: string;
  value: number;
  standardError: number;
  sampleCount: number;
  unit: string;
  direction: "higher_is_better" | "lower_is_better";
}

export interface EvaluationFingerprint {
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
  canonicalization: {
    scheme: "RFC8785";
    textEncoding: "UTF-8";
    absentValue: "JSON null";
    hardwareRegistryVersion: "1.0.0";
  };
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
}

export interface NormalizedEvaluationRun {
  id: string;
  runType: "normalized";
  adapterId: string;
  modelId: string;
  artifact: ArtifactIdentity;
  executionArtifactDigest: string;
  benchmark: BenchmarkDescriptor;
  metrics: NormalizedMetric[];
  settings: EvaluationSetting[];
  rawArtifactIds: string[];
  startedAt: string;
  completedAt: string;
  fingerprint: EvaluationFingerprint;
  comparisonEligible: boolean;
  comparisonEligibilityReasons: string[];
}

export interface EvaluationRegistryV1 {
  $schema: string;
  schemaVersion: "1.0.0";
  generatedAt: string;
  sources: EvaluationSource[];
  adapters: EvaluationAdapter[];
  reportedClaims: OwnerReportedClaim[];
  rawArtifacts: RawEvaluationArtifact[];
  runs: NormalizedEvaluationRun[];
}

declare const evaluations: EvaluationRegistryV1;

export default evaluations;
