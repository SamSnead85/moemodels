# MOEModels

Plan, measure, and verify an exact mixture-of-experts deployment before treating
it as deployment evidence.

MOEModels is an experimental, local-first developer toolchain. It combines a
versioned model and accelerator registry, conservative static-residency math, an
OpenAI-compatible endpoint runner, and a tamper-evident DeployBench Evidence
Passport. It is not a universal leaderboard, model host, or deployment
certification service.

> **Release status:** this repository is prepared for the first public npm
> release, but package publication is a separate maintainer action. Until
> [`moemodels`](https://www.npmjs.com/package/moemodels) is published, use the
> pinned source checkout below. The GitHub Action is available now at `v0`.

```sh
git clone --branch v0 --depth 1 https://github.com/SamSnead85/moemodels.git
cd moemodels
npm ci
npm test
```

## Plan → Run → Verify → Gate

Each phase is one CLI command under the unscoped `moemodels` launcher.

### 1. Plan

Create an explicit validation plan from a pinned artifact, hardware target,
runtime name, workload shape, and service objective:

```sh
npm run moemodels -- plan moonshotai/kimi-k3 nvidia/h200-sxm-141gb \
  --devices 16 \
  --devices-per-node 8 \
  --runtime vllm \
  --input-tokens 4096 \
  --output-tokens 1024 \
  --concurrency 32 \
  --target-ttft-ms 800 \
  --target-inter-token-ms 50 \
  --availability ha \
  --output deployment-plan.json
```

The plan calculates static checkpoint residency and preserves runtime support,
peak memory, latency, routing behavior, quality, and cost as validation gates. A
static pass is not a runtime load test.

### 2. Run

Measure an OpenAI-compatible streaming endpoint you control. Repeat the command
at least three times with an identical resolved configuration:

```sh
MOEMODELS_BENCH_API_KEY=... npm run moemodels -- run \
  --endpoint http://127.0.0.1:8000/v1/chat/completions \
  --model moonshotai/Kimi-K3 \
  --artifact-repository moonshotai/Kimi-K3 \
  --artifact-revision 9f62e4e9fffbd0a83ddd60e1c209d828994b3569 \
  --runtime vllm \
  --runtime-version 0.10.0 \
  --hardware "8x H200 SXM" \
  --topology "1 node; 8 GPUs; NVLink" \
  --requests 32 \
  --concurrency 8 \
  --output trial-01.json
```

Pack compatible trials into one deterministic Passport:

```sh
npm run moemodels -- pack trial-01.json trial-02.json trial-03.json \
  --output passport.json
```

The runner does not store prompt text, response text, or the API key. Review the
artifact before sharing it: endpoint origin and prompt-derived metadata are
retained, and hashes of predictable prompts are not anonymization.

### 3. Verify

Recompute the Passport payload identity, configuration identity, trial
summaries, compatibility gates, and any embedded Ed25519 signatures:

```sh
npm run moemodels -- verify passport.json --json
```

Verification detects structural and content tampering. A valid Passport does
not prove that the endpoint served the declared checkpoint, establish a trusted
operator identity, or make results comparison eligible.

### 4. Gate

Turn verified evidence into an explicit review decision. A deployment policy
declares evidence requirements, absolute thresholds, baseline-relative
regression tolerances with an allowed identity change surface, and expiring
waivers — all as strict, content-addressed JSON:

```sh
npm run moemodels -- policy init --output policy.json
npm run moemodels -- policy check passport.json --policy policy.json \
  --baseline baseline-passport.json --json
npm run moemodels -- compare baseline-passport.json passport.json \
  --allow runtime.version
```

`policy check` answers **pass**, **fail**, or **inconclusive** with distinct
exit codes (`0`, `1`, `3`), so CI can distinguish "regressed" from "cannot
decide". A metric the endpoint did not report, a missing baseline, or an
incomparable configuration is never silently passed. When
`GITHUB_STEP_SUMMARY` is set, a Markdown receipt is appended to the job
summary. The format is specified in
[`docs/POLICY_GATE_V0_1.md`](docs/POLICY_GATE_V0_1.md).

## Requirements and local development

Requirements: Node.js 22.13 or newer and npm 11.

```sh
npm ci
npm test
npm run moemodels -- plan moonshotai/kimi-k3 nvidia/h200-sxm-141gb --devices 16
```

No model weights or accelerator libraries are required for the build and test
suite. Endpoint measurement requires a reachable endpoint and is never invoked
by the tests.

## GitHub Action

Fail a workflow when a committed Passport cannot be verified:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: SamSnead85/moemodels@v0
    with:
      passport: evidence/deployment-passport.json
```

Add a policy (and optionally a baseline Passport) to turn the same step into a
deployment regression gate that writes a Markdown verdict receipt to the job
summary and exposes a `verdict` output:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: SamSnead85/moemodels@v0
    with:
      passport: evidence/candidate-passport.json
      policy: evidence/deployment-policy.json
      baseline: evidence/baseline-passport.json
```

The action verifies cryptographic integrity and protocol semantics, and a
policy verdict covers only the checks the policy declares. It does not admit
the result into a comparison cohort or trust a self-signed operator key.

## Packages

| Package | Responsibility |
| --- | --- |
| [`moemodels`](packages/moemodels) | Public Plan → Run → Verify → Gate launcher |
| [`@moemodels/core`](packages/core) | Registry validation, static residency, and validation plans |
| [`@moemodels/bench`](packages/bench) | Endpoint trials, Passport packing, signing, and verification |
| [`@moemodels/policy`](packages/policy) | Policy-as-code regression gate over verified Passports |
| [`@moemodels/cli`](packages/cli) | Registry, fit, plan, and evaluation commands |
| [`@moemodels/ingest`](packages/ingest) | Pinned evidence import adapters, beginning with `lm-eval` |
| [`@moemodels/sdk`](packages/sdk) | Browser-safe typed client for the hosted HTTP API |
| [`@moemodels/mcp`](packages/mcp) | Read-only MCP tools over the registry and planning engine |
| [`@moemodels/registry-v1`](data/v1) | Versioned model and accelerator records |
| [`@moemodels/evaluations-v1`](data/evaluations/v1) | Versioned reported claims and normalized-run schema |

## Evidence state and boundaries

At this repository baseline:

- the registry contains five exact model artifacts and four accelerator records;
- the evaluation registry contains 15 owner-reported claims;
- there are zero admitted normalized evaluation runs and zero first-party
  controlled deployment runs;
- owner-reported claims remain non-comparable;
- runtime compatibility remains `unknown` unless an exact evidence record says
  otherwise;
- the endpoint runner measures the endpoint but cannot independently prove its
  backing model, runtime, or hardware.

Read the [DeployBench v0.1 protocol draft](docs/DEPLOYBENCH_V0_1.md), the
[Evidence Passport v0.2 methodology](docs/DEPLOYMENT_PASSPORT_V0_2.md), and the
[Policy Gate v0.1 format](docs/POLICY_GATE_V0_1.md) before publishing or
comparing results.

## Development

```sh
npm ci
npm run build
npm run test:unit
npm run test:package-smoke
npm run check:public-boundary
```

The package smoke test packs all ten workspaces, installs the tarballs in an
empty temporary project, and executes the public launcher, policy gate, SDK,
and MCP server.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md),
[SECURITY.md](SECURITY.md), [RELEASING.md](RELEASING.md), and [NOTICE](NOTICE).
Code is licensed under [Apache-2.0](LICENSE); source records and the copied test
fixture retain their own cited terms and provenance.
