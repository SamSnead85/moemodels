import type { Registry } from "@moemodels/core";

import type {
  ApiErrorBody,
  EvaluationDetailResponse,
  EvaluationFilters,
  EvaluationsResponse,
  FitRequest,
  FitResponse,
  PlanRequest,
  PlanResponse,
} from "./types.js";

export * from "./types.js";

export const DEFAULT_MOEMODELS_BASE_URL = "https://moemodels.ai";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface MoeModelsClientOptions {
  baseUrl?: string | URL;
  fetch?: FetchLike;
  headers?: HeadersInit;
}

export class MoeModelsApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: unknown;

  constructor(message: string, options: { status: number; url: string; body: unknown }) {
    super(message);
    this.name = "MoeModelsApiError";
    this.status = options.status;
    this.url = options.url;
    this.body = options.body;
  }
}

function parseBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const candidate = body as ApiErrorBody;
    if (typeof candidate.message === "string" && candidate.message.trim() !== "") {
      return candidate.message;
    }
  }
  return `MOEModels API request failed with HTTP ${status}.`;
}

function setString(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined) params.set(key, value);
}

function setNumber(params: URLSearchParams, key: string, value: number | undefined): void {
  if (value !== undefined) params.set(key, String(value));
}

export class MoeModelsClient {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  readonly headers: Headers;

  constructor(options: MoeModelsClientOptions = {}) {
    const baseUrl = new URL(options.baseUrl ?? DEFAULT_MOEMODELS_BASE_URL);
    baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
    this.baseUrl = baseUrl.toString().replace(/\/$/, "");

    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") {
      throw new TypeError("A Fetch API-compatible implementation is required.");
    }
    this.fetch = fetchImplementation.bind(globalThis);
    this.headers = new Headers(options.headers);
  }

  private async request<T>(path: string): Promise<T> {
    const url = new URL(path, `${this.baseUrl}/`);
    const headers = new Headers(this.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");

    const response = await this.fetch(url, { method: "GET", headers });
    const body = parseBody(await response.text());
    if (!response.ok) {
      throw new MoeModelsApiError(errorMessage(body, response.status), {
        status: response.status,
        url: url.toString(),
        body,
      });
    }
    if (typeof body !== "object" || body === null) {
      throw new MoeModelsApiError("MOEModels API returned a non-JSON response.", {
        status: response.status,
        url: url.toString(),
        body,
      });
    }
    return body as T;
  }

  registry(): Promise<Registry> {
    return this.request<Registry>("api/v1/registry");
  }

  fit(input: FitRequest): Promise<FitResponse> {
    const params = new URLSearchParams({ model: input.model, hardware: input.hardware });
    setNumber(params, "devices", input.devices);
    setNumber(params, "devicesPerNode", input.devicesPerNode);
    setNumber(params, "reserveBps", input.reserveBps);
    return this.request<FitResponse>(`api/v1/fit?${params.toString()}`);
  }

  evaluations(filters: EvaluationFilters = {}): Promise<EvaluationsResponse> {
    const params = new URLSearchParams();
    setString(params, "model", filters.model);
    setString(params, "suite", filters.suite);
    setString(params, "artifactAssociation", filters.artifactAssociation);
    const query = params.size === 0 ? "" : `?${params.toString()}`;
    return this.request<EvaluationsResponse>(`api/v1/evaluations${query}`);
  }

  evaluation(id: string): Promise<EvaluationDetailResponse> {
    if (id.trim() === "") throw new TypeError("Evaluation id must be non-empty.");
    return this.request<EvaluationDetailResponse>(
      `api/v1/evaluations/${encodeURIComponent(id)}`,
    );
  }

  plan(input: PlanRequest): Promise<PlanResponse> {
    const params = new URLSearchParams({ model: input.model, hardware: input.hardware });
    setNumber(params, "devices", input.devices);
    setNumber(params, "devicesPerNode", input.devicesPerNode);
    setNumber(params, "reserveBps", input.reserveBps);
    setString(params, "runtime", input.runtime);
    setNumber(params, "inputTokens", input.inputTokens);
    setNumber(params, "outputTokens", input.outputTokens);
    setNumber(params, "concurrency", input.concurrency);
    setNumber(params, "targetTtftMs", input.targetTtftMs);
    setNumber(params, "targetInterTokenMs", input.targetInterTokenMs);
    setString(params, "availability", input.availability);
    return this.request<PlanResponse>(`api/v1/plan?${params.toString()}`);
  }
}

export function createMoeModelsClient(options: MoeModelsClientOptions = {}): MoeModelsClient {
  return new MoeModelsClient(options);
}
