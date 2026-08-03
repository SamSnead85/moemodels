export const ENDPOINT_BENCHMARK_ADMISSION_NOTICE =
  "A standalone endpoint run is not comparison eligible until admitted under the complete MOEModels evidence protocol.";

export interface EndpointBenchmarkOptions {
  endpoint: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  requests: number;
  concurrency: number;
  warmupRequests?: number;
  timeoutMs?: number;
  apiKey?: string;
  artifactRepository?: string;
  artifactRevision?: string;
  runtime?: string;
  runtimeVersion?: string;
  hardware?: string;
  topology?: string;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  wallClock?: () => Date;
}

export interface RequestMeasurement {
  requestIndex: number;
  status: "succeeded" | "failed";
  httpStatus: number | null;
  ttftMs: number | null;
  totalLatencyMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
  outputCharacters: number;
  errorCode: string | null;
}

export interface DistributionSummary {
  minimum: number;
  p50: number;
  p95: number;
  p99: number;
  maximum: number;
  mean: number;
}

export interface EndpointBenchmarkResult {
  schemaVersion: "0.1.0";
  kind: "moemodels_endpoint_benchmark";
  classification: {
    evidenceClass: "measured";
    comparisonEligible: false;
    reason: string;
  };
  run: {
    id: string;
    startedAt: string;
    completedAt: string;
    endpointOrigin: string;
    model: string;
    artifact: {
      binding: "exact_revision" | "endpoint_model_name_only";
      repository: string | null;
      revision: string | null;
    };
    runtime: { name: string | null; version: string | null };
    infrastructure: { hardware: string | null; topology: string | null };
  };
  workload: {
    protocol: "openai_chat_completions_stream";
    promptSha256: string;
    promptUtf8Bytes: number;
    maxOutputTokens: number;
    requests: number;
    concurrency: number;
    warmupRequests: number;
    temperature: 0;
  };
  summary: {
    attemptedRequests: number;
    successfulRequests: number;
    failedRequests: number;
    wallTimeMs: number;
    requestThroughputPerSecond: number;
    outputTokenThroughputPerSecond: number | null;
    ttftMs: DistributionSummary | null;
    totalLatencyMs: DistributionSummary | null;
  };
  measurements: readonly RequestMeasurement[];
  missingContext: readonly string[];
  privacy: {
    promptStored: false;
    responseTextStored: false;
    apiKeyStored: false;
    statement: string;
  };
}
