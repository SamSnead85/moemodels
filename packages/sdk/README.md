# `@moemodels/sdk`

Typed, browser-safe access to the public MOEModels.ai JSON APIs. The repository
is prepared for public npm publication; until a release is available, build it
from a source checkout.

The client wraps sourced registry records, owner-reported evaluation evidence,
normalized runs when they exist, calculated checkpoint-residency lower bounds,
and deployment-validation plans. A fit or plan response is not a measured
runtime result, hardware certification, or production recommendation.

## Usage

```ts
import { createMoeModelsClient } from "@moemodels/sdk";

const moe = createMoeModelsClient();

const registry = await moe.registry();
const fit = await moe.fit({
  model: "kimi-k3",
  hardware: "h200",
  devices: 16,
  devicesPerNode: 8,
  reserveBps: 1300,
});

const evidence = await moe.evaluations({ model: "kimi-k3", suite: "GPQA" });
const plan = await moe.plan({
  model: "kimi-k3",
  hardware: "h200",
  runtime: "vllm",
  inputTokens: 4096,
  outputTokens: 1024,
  concurrency: 32,
  targetTtftMs: 800,
  targetInterTokenMs: 50,
  availability: "ha",
});
```

The server supplies documented defaults for omitted numeric planning fields.
The SDK only serializes values provided by the caller; it does not silently
create workload or SLA evidence.

## Configuration

Use a custom origin or Fetch implementation for tests, a proxy, or a compatible
self-hosted deployment:

```ts
const moe = createMoeModelsClient({
  baseUrl: "https://internal.example",
  fetch: globalThis.fetch,
  headers: { "x-client": "deployment-review" },
});
```

Non-2xx responses throw `MoeModelsApiError` with `status`, `url`, and the parsed
response `body`.

## Local verification

From this package directory:

```sh
npm run build
npm test
```

The package has no Node-only runtime imports. It relies on the standard Fetch,
URL, URLSearchParams, Headers, and Response APIs available in modern browsers
and current Node.js releases.
