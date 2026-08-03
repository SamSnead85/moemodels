import { createHash } from "node:crypto";

import {
  roundMeasurement,
  summarizeRequestMeasurements,
} from "./summary.js";
import {
  ENDPOINT_BENCHMARK_ADMISSION_NOTICE,
  type EndpointBenchmarkOptions,
  type EndpointBenchmarkResult,
  type RequestMeasurement,
} from "./types.js";

interface StreamUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 0 through ${maximum}.`);
  }
  return value;
}

function optionalLabel(value: string | undefined, label: string): string | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) return null;
  if (normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new RangeError(`${label} must be 1–256 printable characters.`);
  }
  return normalized;
}

function validateEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new RangeError("endpoint must use http or https.");
  }
  if (endpoint.username || endpoint.password) {
    throw new RangeError("endpoint must not contain embedded credentials.");
  }
  if (endpoint.hash) throw new RangeError("endpoint must not contain a URL fragment.");
  return endpoint;
}

function numericUsage(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseStreamPayload(
  payload: string,
  onContent: (content: string) => void,
  usage: StreamUsage,
): void {
  if (payload === "[DONE]") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const root = parsed as Record<string, unknown>;
  const choices = root.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (typeof choice !== "object" || choice === null) continue;
      const delta = (choice as Record<string, unknown>).delta;
      if (typeof delta !== "object" || delta === null) continue;
      const content = (delta as Record<string, unknown>).content;
      if (typeof content === "string" && content.length > 0) onContent(content);
    }
  }
  if (typeof root.usage === "object" && root.usage !== null) {
    const rawUsage = root.usage as Record<string, unknown>;
    usage.promptTokens = numericUsage(rawUsage.prompt_tokens);
    usage.completionTokens = numericUsage(rawUsage.completion_tokens);
  }
}

async function measureRequest(input: {
  requestIndex: number;
  endpoint: URL;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  apiKey: string | undefined;
  fetchImplementation: typeof fetch;
  now: () => number;
}): Promise<RequestMeasurement> {
  const started = input.now();
  let httpStatus: number | null = null;
  let firstContentAt: number | null = null;
  let outputCharacters = 0;
  const usage: StreamUsage = { promptTokens: null, completionTokens: null };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await input.fetchImplementation(input.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: input.prompt }],
        max_tokens: input.maxOutputTokens,
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });
    httpStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      return {
        requestIndex: input.requestIndex,
        status: "failed",
        httpStatus,
        ttftMs: null,
        totalLatencyMs: roundMeasurement(input.now() - started),
        promptTokens: null,
        outputTokens: null,
        outputCharacters: 0,
        errorCode: `http_${response.status}`,
      };
    }
    if (!response.body) throw new Error("response_body_missing");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const onContent = (content: string) => {
      if (firstContentAt === null) firstContentAt = input.now();
      outputCharacters += content.length;
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        parseStreamPayload(line.slice(5).trim(), onContent, usage);
      }
      if (done) break;
    }
    if (buffer.startsWith("data:")) {
      parseStreamPayload(buffer.slice(5).trim(), onContent, usage);
    }

    const completed = input.now();
    return {
      requestIndex: input.requestIndex,
      status: "succeeded",
      httpStatus,
      ttftMs: firstContentAt === null ? null : roundMeasurement(firstContentAt - started),
      totalLatencyMs: roundMeasurement(completed - started),
      promptTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      outputCharacters,
      errorCode: null,
    };
  } catch (error) {
    const code =
      controller.signal.aborted
        ? "timeout"
        : error instanceof Error && /^[a-z0-9_]{1,64}$/i.test(error.message)
          ? error.message.toLowerCase()
          : "request_failed";
    return {
      requestIndex: input.requestIndex,
      status: "failed",
      httpStatus,
      ttftMs: null,
      totalLatencyMs: roundMeasurement(input.now() - started),
      promptTokens: null,
      outputTokens: null,
      outputCharacters,
      errorCode: code,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runEndpointBenchmark(
  options: EndpointBenchmarkOptions,
): Promise<EndpointBenchmarkResult> {
  const endpoint = validateEndpoint(options.endpoint);
  const modelValue = optionalLabel(options.model, "model");
  if (modelValue === null) throw new RangeError("model is required.");
  const model: string = modelValue;
  if (options.prompt.length === 0 || options.prompt.length > 1_000_000) {
    throw new RangeError("prompt must contain 1–1,000,000 characters.");
  }
  const maxOutputTokens = positiveInteger(options.maxOutputTokens, "maxOutputTokens", 1_000_000);
  const requests = positiveInteger(options.requests, "requests", 100_000);
  const concurrency = positiveInteger(options.concurrency, "concurrency", 10_000);
  if (concurrency > requests) throw new RangeError("concurrency cannot exceed requests.");
  const warmupRequests = nonNegativeInteger(options.warmupRequests ?? 0, "warmupRequests", 10_000);
  const timeoutMs = positiveInteger(options.timeoutMs ?? 120_000, "timeoutMs", 3_600_000);
  const artifactRepository = optionalLabel(options.artifactRepository, "artifactRepository");
  const artifactRevision = optionalLabel(options.artifactRevision, "artifactRevision");
  if ((artifactRepository === null) !== (artifactRevision === null)) {
    throw new RangeError("artifactRepository and artifactRevision must be supplied together.");
  }
  const runtime = optionalLabel(options.runtime, "runtime");
  const runtimeVersion = optionalLabel(options.runtimeVersion, "runtimeVersion");
  const hardware = optionalLabel(options.hardware, "hardware");
  const topology = optionalLabel(options.topology, "topology");
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? (() => performance.now());
  const wallClock = options.wallClock ?? (() => new Date());
  const startedAt = wallClock().toISOString();
  const promptSha256 = createHash("sha256").update(options.prompt, "utf8").digest("hex");

  for (let index = 0; index < warmupRequests; index += 1) {
    await measureRequest({
      requestIndex: -(index + 1),
      endpoint,
      model,
      prompt: options.prompt,
      maxOutputTokens,
      timeoutMs,
      apiKey: options.apiKey,
      fetchImplementation,
      now,
    });
  }

  const wallStarted = now();
  const measurements = new Array<RequestMeasurement>(requests);
  let nextRequest = 0;
  async function worker(): Promise<void> {
    while (true) {
      const requestIndex = nextRequest;
      nextRequest += 1;
      if (requestIndex >= requests) return;
      measurements[requestIndex] = await measureRequest({
        requestIndex,
        endpoint,
        model,
        prompt: options.prompt,
        maxOutputTokens,
        timeoutMs,
        apiKey: options.apiKey,
        fetchImplementation,
        now,
      });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requests) }, async () => worker()),
  );
  const wallTimeMs = Math.max(0.001, now() - wallStarted);
  const completedAt = wallClock().toISOString();
  const successful = measurements.filter((measurement) => measurement.status === "succeeded");
  const artifactBinding =
    artifactRepository && artifactRevision ? "exact_revision" : "endpoint_model_name_only";
  const runIdentity = createHash("sha256")
    .update(
      JSON.stringify({
        startedAt,
        endpointOrigin: endpoint.origin,
        model,
        artifactRepository,
        artifactRevision,
        runtime,
        runtimeVersion,
        hardware,
        topology,
        promptSha256,
        maxOutputTokens,
        requests,
        concurrency,
        warmupRequests,
      }),
    )
    .digest("hex");
  const missingContext = [
    ...(artifactBinding === "endpoint_model_name_only"
      ? ["Exact artifact repository and immutable revision were not supplied."]
      : []),
    ...(runtime === null || runtimeVersion === null
      ? ["Exact serving runtime name and version are incomplete."]
      : []),
    ...(hardware === null || topology === null
      ? ["Hardware and topology identity are incomplete."]
      : []),
    ...(successful.some((measurement) => measurement.ttftMs === null)
      ? ["One or more successful streams did not expose a content-bearing first token."]
      : []),
    ...(successful.some((measurement) => measurement.outputTokens === null)
      ? ["One or more successful responses omitted token-usage metadata."]
      : []),
    ENDPOINT_BENCHMARK_ADMISSION_NOTICE,
  ];

  return {
    schemaVersion: "0.1.0",
    kind: "moemodels_endpoint_benchmark",
    classification: {
      evidenceClass: "measured",
      comparisonEligible: false,
      reason:
        "These are direct endpoint measurements, but comparison eligibility requires exact identities, repetitions, raw evidence review, and a complete methodology fingerprint.",
    },
    run: {
      id: `endpoint-sha256-${runIdentity}`,
      startedAt,
      completedAt,
      endpointOrigin: endpoint.origin,
      model,
      artifact: {
        binding: artifactBinding,
        repository: artifactRepository,
        revision: artifactRevision,
      },
      runtime: { name: runtime, version: runtimeVersion },
      infrastructure: { hardware, topology },
    },
    workload: {
      protocol: "openai_chat_completions_stream",
      promptSha256,
      promptUtf8Bytes: Buffer.byteLength(options.prompt, "utf8"),
      maxOutputTokens,
      requests,
      concurrency,
      warmupRequests,
      temperature: 0,
    },
    summary: summarizeRequestMeasurements(measurements, wallTimeMs),
    measurements,
    missingContext,
    privacy: {
      promptStored: false,
      responseTextStored: false,
      apiKeyStored: false,
      statement:
        "The artifact stores only prompt identity/size, aggregate timing, token usage when returned, and output character counts.",
    },
  };
}
