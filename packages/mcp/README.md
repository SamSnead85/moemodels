# `@moemodels/mcp`

A small, dependency-free stdio MCP server over `@moemodels/core`. The repository
is prepared for public npm publication; until a release is available, build it
from a source checkout.

It exposes five read-only tools:

- `search_models` — discover exact versioned model records;
- `compare_sourced_model_properties` — compare static sourced facts without a
  quality or performance ranking;
- `calculate_static_checkpoint_fit` — calculate a checkpoint tensor-residency
  lower bound, clearly labeled as calculated rather than measured;
- `summarize_evaluation_evidence` — inspect owner-reported claims and normalized
  runs without merging their evidence classes;
- `export_deployment_validation_plan` — create a reproducible validation plan
  with required measurement gates.

The server does not run models, execute benchmarks, mutate the registry, fetch
remote content, certify runtime support, or present owner-reported scores as
MOEModels measurements.

## Build and run

Build `@moemodels/core` first, then this package:

```sh
npm run build --workspace @moemodels/core
cd packages/mcp
npm run build
node dist/index.js
```

The server writes newline-delimited JSON-RPC responses to stdout. Diagnostic
failures go to stderr so they do not corrupt the stdio protocol.

## Client configuration

Copy [`examples/client-config.json`](examples/client-config.json) and replace the
example argument with the absolute path to `dist/index.js` in your checkout.

```json
{
  "mcpServers": {
    "moemodels": {
      "command": "node",
      "args": ["/absolute/path/to/moemodels/packages/mcp/dist/index.js"]
    }
  }
}
```

This implementation supports the MCP `initialize`, `ping`, `tools/list`, and
`tools/call` methods over stdio for protocol versions `2025-06-18` and
`2024-11-05`. It deliberately uses no third-party MCP dependency; add broader
protocol surfaces only when a real client workflow requires them.

## Evidence boundary

Model architecture, artifact, and hardware inputs come from the versioned public
registry. Static fit and the deployment-validation plan are deterministic
calculations over those inputs. Runtime load success, peak memory, latency,
throughput, routing health, quality, resilience, and economics remain unknown
until a properly identified run supplies measured evidence.
