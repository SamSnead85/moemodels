# `@moemodels/bench`

`@moemodels/bench` measures an OpenAI-compatible streaming endpoint and can
package repeated compatible trials into a tamper-evident DeployBench Evidence
Passport.

The package is available in the public
[`SamSnead85/moemodels`](https://github.com/SamSnead85/moemodels) developer
repository and is not yet published to npm. It is deliberately narrower than a
leaderboard.

## Evidence Passport v0.2

An Evidence Passport adds four enforceable properties to the existing endpoint
result:

- RFC 8785-style deterministic canonical JSON;
- content-addressed payload and configuration SHA-256 identities;
- strict structural and semantic verification, including summary recomputation;
- optional Ed25519 operator signing with explicit authorship-only semantics.

A passport always retains `comparisonEligible: false`. Three compatible trials
can satisfy its reproducibility gates only when successful requests retain TTFT
and returned token usage, summaries retain token throughput, and no material
`missingContext` remains. The standing comparison-admission notice is
informational and does not itself fail completeness. Comparison admission remains
a separate future MOEModels review. Signing never changes eligibility and does
not prove which model, runtime, hardware, or topology served an endpoint.

## Measure trials

Build from the repository root, then target an endpoint you control:

```sh
npm run build --workspace @moemodels/bench

MOEMODELS_BENCH_API_KEY=... node packages/bench/dist/cli.js run \
  --endpoint http://127.0.0.1:8000/v1/chat/completions \
  --model moonshotai/Kimi-K3 \
  --artifact-repository moonshotai/Kimi-K3 \
  --artifact-revision 9f62e4e9fffbd0a83ddd60e1c209d828994b3569 \
  --runtime vllm \
  --runtime-version 0.10.0 \
  --hardware '8x H200 SXM' \
  --topology '1 node; 8 GPUs; NVLink' \
  --requests 32 \
  --concurrency 8 \
  --warmup-requests 2 \
  --output trial-01.json
```

Repeat the same resolved configuration at least three times. `pack` rejects a
mixture of endpoints, model declarations, runtimes, infrastructure descriptions,
or workloads:

```sh
node packages/bench/dist/cli.js pack \
  trial-01.json trial-02.json trial-03.json \
  --output passport.json

node packages/bench/dist/cli.js verify passport.json --json
```

Every command that writes a file uses create-new semantics and refuses to
overwrite an existing path.

## Optional operator signature

Supply an existing Ed25519 private key in PEM form. The private key is never
written into the passport:

```sh
node packages/bench/dist/cli.js sign passport.json \
  --private-key operator-ed25519.pem \
  --output passport.signed.json

node packages/bench/dist/cli.js verify passport.signed.json
```

A valid embedded signature is reported as `valid_self_signed`,
`authorshipOnly: true`, and `trusted: false`. External key governance and
MOEModels admission are intentionally outside v0.2.

## Node API

```ts
import {
  packEvidencePassport,
  serializeEvidencePassport,
  signEvidencePassport,
  verifyEvidencePassport,
} from "@moemodels/bench";

const passport = await packEvidencePassport([trial1, trial2, trial3]);
const verification = await verifyEvidencePassport(passport);
const signed = await signEvidencePassport(passport, privateKeyPem);
const bytes = serializeEvidencePassport(signed);
```

The main package also exports:

- `canonicalizeJson`, `canonicalJsonBytes`, `canonicalSha256Hex`, and
  `sha256Hex`;
- `computePassportPayloadSha256` and `parseEvidencePassport`;
- `assessEvidencePassportTrials`, `endpointBenchmarkConfiguration`, and
  `validateEndpointBenchmarkResult`;
- `summarizeDistribution` and `summarizeRequestMeasurements`;
- the complete passport, gate, signature, and verification TypeScript types.

## Browser-safe verification

The browser subpath contains no Node imports. It uses Web Crypto for SHA-256 and
Ed25519 verification:

```ts
import {
  verifyEvidencePassport,
  type DeployBenchEvidencePassport,
} from "@moemodels/bench/browser";

const report = await verifyEvidencePassport(passport as DeployBenchEvidencePassport);
```

`@moemodels/bench/browser` exports canonicalization, packing, parsing,
verification, summary recomputation, types, and the existing endpoint result
types. Node-only signing and endpoint execution are excluded.

The JSON Schema is exported as
`@moemodels/bench/passport.schema.json`. Runtime semantic verification remains
normative because JSON Schema alone cannot recompute hashes, summaries,
compatibility, or signatures.

## Evidence boundaries

- A trial measures an endpoint; it does not prove which checkpoint bytes are
  behind the endpoint.
- The current trial format stores the endpoint origin. Review it before sharing
  a passport outside the environment.
- A prompt hash may reveal small or predictable prompts through guessing. It is
  not anonymization.
- Token throughput is `null` when a successful response omits usage metadata.
- TTFT is `null` when a successful stream contains no content-bearing delta.
- Either condition keeps the Passport `request_measurements` reproducibility
  gate incomplete; the verifier does not synthesize the missing observation.
- The runner does not collect GPU telemetry, expert-routing counters, quality
  retention, power, cost, or failure-recovery evidence.
- Prompt text, response text, and API keys are never written to a trial or
  passport.
