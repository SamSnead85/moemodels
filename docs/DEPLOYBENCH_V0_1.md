# DeployBench v0.1 specification

Status: protocol draft with an initial endpoint-measurement runner implemented

Protocol version: `0.1.0-draft`
Implementation: [`@moemodels/bench`](../packages/bench) and
[`Evidence Passport v0.2`](DEPLOYMENT_PASSPORT_V0_2.md)

## Current evidence state

MOEModels has not yet executed or published a controlled benchmark run. The
current evaluation registry contains 15 owner-reported claims, zero normalized
runs, and zero raw run artifacts. The existing pinned `lm-eval` adapter is marked
`pinned_not_executed`.

DeployBench v0.1 defines how the project can produce its first measured systems
evidence without rewriting owner claims as measurements or overstating one
laboratory configuration as a universal result.

The repository includes `@moemodels/bench`, an initial privacy-conscious runner
for OpenAI-compatible streaming endpoints. It measures request-level TTFT,
latency, success, and returned token usage. Compatible repeated trials can be
packed into a content-addressed Evidence Passport v0.2 and optionally signed
with an Ed25519 operator key. The runner still does not implement the full
lifecycle, topology telemetry, complete result bundle, trusted signer policy, or
admission requirements below. No runner output has been admitted to the
canonical evaluation registry.

## Purpose

DeployBench is a local-first, vendor-neutral protocol and runner for answering:

> Can this exact model artifact load and serve this exact workload on this
> runtime and hardware topology, with what resource use, latency, throughput,
> quality guardrail, cost assumptions, and uncertainty?

Version 0.1 establishes a reproducible evidence bundle. It is not intended to
identify a universal best model, GPU, or runtime.

## Goals

- Bind every result to exact model, runtime, hardware, topology, workload, and
  method identities.
- Capture load, run, scale, quality-guardrail, and economics evidence without
  collapsing them into an opaque score.
- Retain request/trial-level raw measurements needed to audit summaries.
- Record MoE-specific routing and communication metrics when the runtime can
  expose them, and mark them unknown otherwise.
- Run inside a customer or contributor environment without uploading weights,
  prompts, secrets, or raw environment dumps.
- Produce a human-readable Deployment Card and a canonical machine-readable
  result bundle with matching content digests.
- Support independent repetition and explicit comparison-eligibility checks.

## Non-goals

- A universal quality leaderboard.
- Certification of security, licensing, reliability, or production readiness.
- Automatic hardware procurement or production deployment.
- A claim that active parameters determine memory requirements.
- Cross-run comparison when workload or method fingerprints are incompatible.
- Synthetic precision for metrics unsupported by a runtime adapter.
- A single composite score that hides service-objective trade-offs.
- Capturing raw customer prompts by default.

## Benchmark unit

The primary unit is a **controlled configuration fingerprint**:

```text
model artifact
+ runtime and container
+ precision and quantization
+ parallelism and launch configuration
+ hardware and topology
+ workload specification
+ service objective
+ measurement protocol
```

A configuration contains one or more repeated trials. Requests within a trial
and trials within a configuration are not counted as separate configurations.
Changing any fingerprint input creates a new configuration.

## Required implementation packages

The exact package split can change before implementation, but responsibilities
must remain separated:

| Planned module | Responsibility |
| --- | --- |
| `@moemodels/bench-schema` | JSON Schemas, types, canonicalization rules, and fixtures |
| `@moemodels/bench-core` | Fingerprinting, validation, aggregation, eligibility, and redaction |
| `@moemodels/bench-runner` | Local orchestration, adapter lifecycle, metric capture, and bundle writing |
| `@moemodels/bench-adapter-*` | Runtime-specific launch, readiness, metric, and capability integration |
| `moemodels bench ...` | CLI user experience over the runner and validator |

Schema and core logic must be usable without accelerator libraries. Runtime
adapters may have separate optional dependencies and installation instructions.

## Run manifest

The normative manifest is canonical JSON. YAML may be accepted as an authoring
format only if it is converted to canonical JSON and the converted bytes are
retained in the bundle.

### Required top-level fields

| Field | Requirement |
| --- | --- |
| `schemaVersion` | Exact DeployBench manifest schema version |
| `runIntentId` | User-created stable ID; not the result fingerprint |
| `createdAt` | RFC 3339 timestamp |
| `model` | Repository, 40-character immutable revision, artifact manifest digest, weight format, declared license reference |
| `runtime` | Name, exact version, source revision, immutable container image digest, adapter name/version |
| `precision` | Weight, activation, KV-cache, and accumulation precision; unknown allowed where not configurable |
| `quantization` | Method, tool/version, source artifact digest, group size or method parameters, or explicit `none` |
| `parallelism` | Tensor, expert, pipeline, and data parallel degrees plus launch configuration |
| `hardware` | Registry accelerator ID, device count, devices per node, CPU, host memory, storage class, and interconnect topology |
| `software` | OS image, kernel, accelerator driver, communication library, and relevant runtime dependencies |
| `workload` | Workload ID/version, canonical hash, prompt/output length distribution, concurrency or arrival model, request count, tokenizer identity |
| `serviceObjective` | Required latency, goodput, quality, availability, and/or budget thresholds; unused dimensions explicitly `null` |
| `protocol` | Warmup, trial count, trial duration/request target, timeout, cooldown, sampling interval, and random seeds |
| `metrics` | Requested metric families and runtime-adapter capability requirements |
| `artifacts` | Local output destination and retention policy |
| `privacy` | Publication intent, prompt capture policy, redaction profile, environment allowlist, and approved metadata classes |
| `costBasis` | Currency, hardware price source, observation date, utilization/amortization assumptions, power price, or explicit `unknown` |

### Identity rules

- Mutable branches, floating image tags, and unversioned runtime names make a run
  publication-ineligible.
- Container identity uses a content digest. A friendly tag may be retained as
  display metadata.
- The model revision alone does not prove the local tensor bytes. The manifest
  must include an artifact or tensor-manifest digest before publication.
- Private workloads can publish a shape-and-method hash without publishing raw
  prompt text. The tokenizer, length buckets, request ordering policy, and
  generation parameters remain required.
- Canonical hashes use RFC 8785 JSON Canonicalization Scheme, UTF-8, and SHA-256.
- An absent optional value and an unknown value are distinct. Unknown values
  carry a reason.

## Workload specification

Version 0.1 supports two workload families:

1. **Fixed-shape:** fixed or enumerated prompt and requested output token counts,
   deterministic concurrency, and a declared number of requests.
2. **Distribution replay:** a versioned histogram or synthetic distribution of
   prompt length, output length, and arrival timing, generated from a declared
   seed without retaining prompt contents.

Each workload declares:

- tokenizer repository and immutable revision;
- chat-template and system-instruction hashes;
- generation parameters and their canonical hash;
- prompt and output token accounting method;
- arrival process, concurrency, and request ordering;
- number of warmup and measured requests;
- whether results include failed or timed-out requests;
- dataset/task identity for any quality guardrail;
- content license or private-use scope.

The first public release should include a small set of clearly named deployment
shapes, not a claim that they represent all production traffic. Suggested
families are interactive-short, interactive-long-context, and batch-throughput.
Their exact lengths and arrival models must be versioned in the repository
before any run uses the name.

## Adapter contract

A runtime adapter implements these lifecycle operations:

```text
capabilities → doctor → resolve → launch → ready → warmup
→ measure → stop → collect → redact → summarize
```

### Required adapter behavior

- `capabilities` reports supported model formats, quantization, parallelism,
  metric families, and MoE instrumentation. It cannot infer support from a
  marketing name.
- `doctor` validates prerequisites without starting paid compute or loading a
  checkpoint.
- `resolve` records exact images, binaries, configuration, and commands before
  execution.
- `launch` emits an allowlisted process specification. Shell interpolation of
  untrusted manifest fields is prohibited.
- `ready` uses a declared health and model-readiness check.
- `warmup` is excluded from measured summaries but retained in a separate raw
  stream.
- `measure` timestamps client-observed events with a monotonic clock and records
  server metrics when supported.
- `stop` is idempotent and runs after success, failure, timeout, or interruption.
- `collect` copies only declared artifacts.
- `redact` applies an allowlist and emits a machine-readable redaction report.
- `summarize` uses shared aggregation functions rather than adapter-specific
  percentile definitions.

An adapter version is part of the fingerprint. Upgrading adapter behavior
without changing its version is prohibited.

## Measurement protocol

### Phases

1. **Resolve:** verify immutable identities and store the resolved manifest.
2. **Preflight:** validate disk, expected lower-bound memory, device visibility,
   runtime compatibility evidence, ports, permissions, output space, and clock
   source.
3. **Cold load:** start from a declared clean state and record load outcome,
   load duration, resource samples, and errors.
4. **Warmup:** satisfy the manifest's request or duration threshold. Keep warmup
   samples separate.
5. **Measured trials:** execute the exact workload for the declared number of
   independent trials.
6. **Cooldown:** record post-trial resource state and stop the runtime.
7. **Collect and redact:** write raw artifacts, hashes, redaction report, and
   incomplete-state diagnostics if needed.
8. **Summarize and validate:** compute shared metrics, confidence information,
   eligibility, and the result fingerprint.

### Minimum repetition

- A publication-eligible configuration requires at least three measured trials.
- Each trial must satisfy the versioned workload's minimum request count or
  duration.
- Warmup policy, cooldown policy, and trial ordering are fingerprinted.
- A failed trial remains in the bundle. It cannot be silently rerun and removed.
- Additional reruns create a superseding bundle that references, rather than
  overwrites, the earlier bundle.

Three trials are a minimum evidence rule, not a guarantee of statistical power.
Raw request-level observations and trial-level summaries remain available so
later analysis can identify insufficient sample sizes or unstable results.

### Timing and token rules

- Client timings use a monotonic clock and record clock implementation and
  resolution.
- Time to first token begins immediately before request transmission and ends
  when the first output token or chunk is observable by the client.
- Inter-token latency uses successive observable output-token event times. If a
  transport coalesces tokens, the adapter records that limitation.
- End-to-end latency ends on the final response event or failure.
- Input and output token counts use the declared tokenizer revision. Server
  counts may be retained separately but cannot silently replace canonical
  counts.
- Streaming and non-streaming results are different workload/method cells.

## Metrics

Metrics are grouped by decision dimension. Each result includes unit, direction,
sample count, aggregation, collection source, and support status.

### Load

| Metric | Definition |
| --- | --- |
| `load_success` | Runtime reaches declared model-ready state before timeout |
| `load_time_seconds` | Launch initiation to model-ready state |
| `checkpoint_tensor_bytes` | Exact tensor bytes from the artifact manifest, not active parameters |
| `accelerator_memory_idle_bytes` | Per-device memory before runtime launch |
| `accelerator_memory_ready_bytes` | Per-device memory at model-ready state after declared stabilization |
| `accelerator_memory_peak_load_bytes` | Per-device peak during cold load at sampling resolution |
| `host_memory_peak_load_bytes` | Host peak during cold load, when measurable |
| `load_error` | Structured stage, code, and safe diagnostic for unsuccessful load |

Load success does not imply the workload can run or meet its objective.

### Run

| Metric | Definition |
| --- | --- |
| `ttft_ms` | Client-observed time to first output token or chunk |
| `inter_token_latency_ms` | Client-observed time between successive output-token events |
| `request_latency_ms` | Client-observed end-to-end request latency |
| `input_tokens_per_second` | Canonical input tokens divided by measured processing interval, when separable |
| `output_tokens_per_second` | Canonical output tokens divided by generation interval |
| `requests_per_second` | Completed requests divided by measured wall time |
| `accelerator_memory_peak_run_bytes` | Per-device peak during measured trials |
| `host_memory_peak_run_bytes` | Host peak during measured trials, when measurable |
| `request_failure_rate` | Failed or timed-out measured requests divided by attempted requests |

Latency summaries report at least median, P90, P95, and P99 using one published
quantile method, plus count, minimum, maximum, mean, and standard deviation. A
summary with too few observations for a meaningful tail percentile remains
computable but carries an explicit diagnostic.

### Scale and service objective

| Metric | Definition |
| --- | --- |
| `offered_request_rate` | Requests offered per second by the workload driver |
| `completed_request_rate` | Successful requests completed per second |
| `goodput_request_rate` | Successful requests per second satisfying all declared per-request SLA thresholds |
| `concurrency_observed` | Time-weighted active-request concurrency |
| `saturation_event_count` | Declared queue, timeout, OOM, or backpressure events |
| `service_objective_pass` | Boolean derived from all declared thresholds, with each contributing value exposed |

Maximum stable concurrency is not directly observed from a single trial. It may
be calculated only by a versioned sweep method with declared stopping and
stability rules.

### MoE-specific instrumentation

These metrics are optional in v0.1 because runtime support is uneven. An adapter
must label each as measured, unsupported, or unknown with a reason.

| Metric | Definition |
| --- | --- |
| `expert_token_count` | Tokens dispatched to each expert for each instrumented layer or declared aggregation |
| `expert_load_cv` | Standard deviation divided by mean of expert token counts, with zero-mean handling defined |
| `expert_load_max_mean_ratio` | Maximum expert token count divided by mean expert token count |
| `inactive_expert_fraction` | Experts receiving zero tokens divided by instrumented experts |
| `routing_entropy_normalized` | Entropy of expert dispatch distribution divided by log of instrumented expert count |
| `expert_capacity_drop_rate` | Tokens dropped or rerouted because of capacity divided by dispatched tokens |
| `all_to_all_time_fraction` | Instrumented all-to-all time divided by declared measured server interval |
| `expert_cache_hit_rate` | Runtime-declared expert cache hits divided by eligible accesses |
| `expert_transfer_bytes` | Instrumented bytes transferred for expert movement or dispatch |

Layer aggregation, top-k routing semantics, shared experts, capacity factors,
token duplication, and sampling coverage must be explicit. Metrics from different
instrumentation scopes are not directly comparable.

### Quality guardrail

Quality results are not mixed into systems percentiles. A guardrail uses a
pinned task/dataset, exact harness revision, task hash, dataset revision, prompt
template hashes, seeds, sampling configuration, and effective sample count.

Version 0.1 may import a compatible normalized `lm-eval` result or run a pinned
adapter. A quality delta compares the candidate configuration with a declared
reference artifact/configuration on the exact same task fingerprint. Without a
compatible reference, the result is an absolute measurement, not preservation.

The protocol does not define a universal aggregate quality score.

### Economics and energy

Economics are calculated evidence derived from measured resource/time results
and an explicit cost basis:

- cost per one million canonical input tokens;
- cost per one million canonical output tokens;
- cost per successful request;
- device-hours per workload unit;
- energy per output token or request, only when power is directly measured by a
  declared source;
- cost of redundancy for the declared HA plan.

Cloud prices include SKU, region, purchasing model, observation time, and
billing granularity. Owned-hardware estimates include purchase price,
amortization horizon, utilization, power, and any included host/network costs.
Unknown cost inputs produce unknown economics rather than default market prices.

Measured power and advertised TDP are different evidence classes. TDP must not
be presented as measured energy.

## Aggregation and uncertainty

- Raw request observations are summarized within each trial first.
- The configuration summary preserves trial-level values and reports the median
  of trial summaries for the primary point estimate unless a metric definition
  specifies another versioned aggregation.
- Quantile algorithm and interpolation rule are fixed by protocol version.
- Confidence intervals, when reported, include method, confidence level, unit of
  resampling, and seed.
- Outliers are retained. Any secondary trimmed analysis is labeled and does not
  replace the primary result.
- Failed and timed-out requests are included in failure rates and excluded from
  successful-request latency distributions with both counts visible.
- Prediction intervals and measurement intervals are different fields.
- Cross-day or cross-host repetitions are separate bundles linked by a
  reproduction relationship.

## Result bundle

The runner writes a content-addressed directory or archive:

```text
deploybench-<run-id>/
  manifest.author.json
  manifest.resolved.json
  environment.json
  capabilities.json
  events.ndjson
  requests.ndjson
  resources.ndjson
  routing.ndjson              # only when supported
  quality/                    # only when requested
  logs/                       # allowlisted, redacted logs
  summary.json
  eligibility.json
  redaction-report.json
  checksums.sha256
  deployment-card.md
  signature.json              # optional in v0.1
```

The bundle manifest records every file's media type, byte length, SHA-256 digest,
capture stage, privacy class, and required/optional status. Missing optional
artifacts are explicit. Missing required artifacts make the bundle incomplete.

NDJSON records have a schema version and monotonically increasing local sequence
number. Timestamps alone are not used to infer record ordering.

## Privacy and security

### Default-deny capture

The runner uses an allowlist. It must not capture these values by default:

- raw prompt or response text;
- tokens or token IDs from private workloads;
- environment variables outside the declared allowlist;
- credentials, cookies, headers, API keys, SSH material, or cloud metadata;
- user names, home paths, hostnames, IP addresses, or organization identifiers;
- model weights or restricted dataset contents;
- unrestricted process lists or system logs.

Hashes can still reveal small or predictable private values. The runner must not
claim that hashing raw prompts anonymizes them. Private workload identity should
be derived from a user-controlled opaque ID plus a structured workload shape,
not a public hash of prompt text.

### Execution safety

- Manifests and imported source documents are untrusted data, never executable
  instructions.
- Adapters construct argument arrays without shell evaluation.
- Runtime images and external code are pinned but not thereby trusted; the user
  remains responsible for sandboxing and licenses.
- `doctor` reports planned commands, images, mounts, ports, estimated storage,
  and potential paid resources before execution.
- Hosted publication revalidates all bundle digests and schemas.
- A public bundle passes automated secret scanning and manual review for v0.1.

## Eligibility

A bundle has one of four publication states:

- `eligible`: satisfies all protocol and evidence requirements for its declared
  result families;
- `incomplete`: potentially useful but missing required evidence;
- `fixture_only`: deterministic software test data, never performance evidence;
- `withdrawn`: previously published, retained as a tombstone with reason.

### Minimum eligibility rules

An `eligible` v0.1 systems bundle requires:

- exact model revision and artifact-manifest digest;
- exact runtime, adapter, and container digest;
- hardware registry identity and complete device/node topology;
- resolved workload and protocol fingerprints;
- declared driver, OS, communication library, and relevant dependency versions;
- separate warmup and measured observations;
- at least three measured trials satisfying workload minimums;
- request counts, token accounting, failures, and timeouts;
- required resource and load observations at a declared sampling resolution;
- raw artifact checksums and a passing redaction report;
- summary values reproducible from included raw observations;
- no unexplained missing required fields or validation errors.

Quality and MoE instrumentation eligibility are evaluated independently. A run
can be systems-eligible while those result families remain absent or unsupported.

Payment, sponsorship, maintainer status, and vendor affiliation cannot waive an
eligibility rule. Disputes and methodology changes are recorded publicly.

## Comparison rules

Two results may share a comparison cohort only when all fields designated by the
metric family match exactly or the published method defines a controlled sweep.

At minimum, direct systems comparisons require compatible:

- model artifact for runtime/hardware comparisons, or runtime/hardware for model
  comparisons;
- workload, tokenizer, prompt/output shape, generation configuration, and
  streaming mode;
- service-objective semantics;
- warmup, trial, timeout, token-accounting, and timing methods;
- requested precision and quantization identity;
- metric support and collection source.

When a field differs, the UI and API report the exact mismatch. Results may be
displayed side by side as non-comparable evidence but cannot be ranked as one
cohort.

## Deployment Card

Every eligible bundle produces a Markdown and JSON Deployment Card containing:

1. Exact artifact, runtime, software, hardware, and topology identity.
2. Workload and service objective.
3. Load outcome and resource use.
4. Latency, throughput, failure, and goodput summaries.
5. Quality guardrail and MoE instrumentation when available.
6. Calculated economics with complete assumptions.
7. Trial variance, collection limitations, and unsupported metrics.
8. Eligibility result, bundle digest, method version, and reproduction links.
9. A concise `Observed here; not established elsewhere` scope statement.

The card may display a `MOEModels eligible run` badge. It must not use
`certified`, `production ready`, or `best` unless a future separately defined
program supplies those meanings.

## CLI workflow

The intended local workflow is:

```bash
moemodels bench init \
  --model <registry-artifact-id> \
  --runtime <adapter-id> \
  --workload <workload-id> \
  --output deploybench.json

moemodels bench doctor --manifest deploybench.json
moemodels bench run --manifest deploybench.json
moemodels bench validate ./deploybench-<run-id>
moemodels bench card ./deploybench-<run-id> --format markdown
moemodels bench publish ./deploybench-<run-id> --dry-run
```

`publish` is the only command in this sequence that sends bundle content to
MOEModels. It lists the exact files, byte counts, privacy classes, destination,
and visibility before requiring confirmation. CI can use an explicit token and
`--yes` after reviewing the same machine-readable upload plan.

## Initial coverage plan

Hardware access and model licenses determine the exact matrix. The first release
should prefer a narrow, complete matrix over scattered one-off runs.

Minimum v0.1 evidence target:

- at least two exact MoE artifacts whose licenses permit the planned testing;
- at least two runtime adapters;
- at least two hardware/topology targets;
- at least two fixed-shape workloads;
- one precision per artifact first, followed by a controlled quantization or
  parallelism sweep;
- at least three measured trials per configuration;
- a directly repeated configuration on a different day;
- one intentionally unsupported or failed configuration retained to validate
  failure semantics.

No target should be announced until the artifact, runtime, hardware access,
workload license, and adapter capability are confirmed.

## Implementation sequence and acceptance tests

### Phase A — schema and fixtures

Deliver:

- manifest, event, raw observation, summary, eligibility, redaction, and bundle
  JSON Schemas;
- canonicalization and fingerprint implementation;
- one successful fixture, one interrupted fixture, one redaction failure, and
  one incompatibility pair;
- aggregation functions with locked expected outputs.

Accept when:

- schemas reject unknown fields at evidence boundaries;
- semantically identical manifests produce identical fingerprints despite JSON
  property order;
- changing every fingerprint field changes the digest in a parameterized test;
- summaries regenerate byte-for-byte from fixture observations;
- fixture bundles are always labeled `fixture_only` and cannot be published as
  performance evidence;
- implementations pass on a clean checkout without an accelerator.

### Phase B — local runner skeleton

Deliver:

- adapter interface and mock adapter;
- doctor, lifecycle, interruption, timeout, collection, redaction, checksum, and
  card generation;
- CLI `init`, `doctor`, `run`, `validate`, and `card` commands.

Accept when:

- a mock run exercises the complete lifecycle and cleanup path;
- `SIGINT`, adapter failure, and timeout each produce an incomplete valid bundle;
- no undeclared network call occurs in offline mode;
- the redaction scanner catches seeded secrets and private identifiers;
- all CLI commands have tested JSON output and exit codes.

### Phase C — first runtime and real run

Deliver:

- one pinned runtime adapter;
- one versioned public workload;
- raw client timing and accelerator resource sampling;
- the first repeated real controlled configuration and run-detail page.

Accept when:

- the resolved command and environment can be reconstructed from the bundle;
- summary values reproduce from raw observations;
- cold load, warmup, and measured phases are distinguishable;
- every device is represented in memory observations;
- failed/time-out request counts reconcile with attempted requests;
- manual review finds no secret, prompt, weight, or undeclared host identity;
- the card states that it is the project's first configuration and avoids broad
  claims.

### Phase D — comparison and reproduction

Deliver:

- second adapter and expanded controlled matrix;
- comparison compatibility engine;
- independent reproduction links and diff view;
- prediction-versus-observed record shape.

Accept when:

- compatible runs form a cohort and incompatible runs expose exact mismatches;
- a second-day repeat retains both bundles and reports variance;
- an independent contributor can validate and submit a bundle using only public
  documentation and tools;
- predictions carry engine version, supported coverage, interval, and residual;
- no prediction is labeled calibrated before a frozen holdout report exists.

## Versioning and governance

- Schemas use semantic versions. Breaking identity or metric changes require a
  new major version.
- Protocol errata cannot rewrite published bundle bytes; they annotate affected
  records and may change eligibility prospectively or through an auditable
  review.
- Workload definitions, aggregation rules, and adapter versions have their own
  immutable revisions.
- The repository records design decisions for timing, token accounting,
  aggregation, privacy, and comparison changes.
- A benchmark-method change includes migration guidance and tests demonstrating
  whether old and new runs can be compared.
- Public run withdrawal preserves ID, digest, reason, date, and affected
  comparisons.

## v0.1 exit criteria

DeployBench v0.1 is complete only when:

- at least one non-fixture bundle from real hardware is eligible under the
  published rules;
- another operator can reproduce its summary from bundled raw evidence;
- local and hosted validators agree on the fingerprint and eligibility;
- the web application renders the run without losing provenance or unknowns;
- the Decision Bundle can reference it from a deployment plan;
- no current owner-reported claim is relabeled as a DeployBench measurement;
- documentation names unsupported dimensions and the exact initial coverage;
- a third party can attempt a repetition using the public runner and manifest.

Until those criteria are met, DeployBench must remain labeled `draft` or
`experimental`. The product must report the exact current count of eligible
controlled runs—including zero at this specification's baseline—and must not
imply that the benchmark is generally available.
