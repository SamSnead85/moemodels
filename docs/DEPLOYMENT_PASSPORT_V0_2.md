# DeployBench Evidence Passport v0.2

Status: implemented experimental evidence envelope

Schema version: `0.2.0`

Normative implementation:

- [`packages/bench/passport.schema.json`](../packages/bench/passport.schema.json)
- [`packages/bench/src/passport.ts`](../packages/bench/src/passport.ts)
- [`packages/bench/src/passport-verify.ts`](../packages/bench/src/passport-verify.ts)
- [`packages/bench/src/passport-sign.ts`](../packages/bench/src/passport-sign.ts)

The TypeScript verifier is normative for semantic checks that JSON Schema
cannot express. This document explains the implemented behavior and its trust
boundary; it does not enlarge that behavior.

## Purpose

An Evidence Passport binds compatible endpoint trials into one deterministic,
portable object. A reviewer can answer:

1. Are the bytes structurally valid for Passport v0.2?
2. Has the canonical payload changed?
3. Do all trials describe the same deployment configuration?
4. Do retained request measurements reproduce the stored summaries?
5. Are the minimum reproducibility declarations internally consistent?
6. Did an embedded Ed25519 key sign this payload digest?

The Passport is designed for repository artifacts, CI gates, review workflows,
and later registry admission. Verification is local and requires no MOEModels
account or hosted service.

## What a valid Passport does not prove

A valid Passport does not independently prove:

- which checkpoint bytes were served by an endpoint;
- that the declared runtime, hardware, or topology was actually used;
- that an operator key belongs to a known person or organization;
- that prompts, responses, or endpoint behavior were unbiased;
- that a configuration is secure, licensed, reliable, or production ready;
- that two Passports are eligible for direct comparison;
- that an observation generalizes beyond the recorded configuration.

Every v0.2 Passport therefore retains
`classification.comparisonEligible: false`. Packing, signing, or successfully
verifying a Passport cannot change that value.

## Object model

The top-level object contains exactly:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Exact Passport schema version, currently `0.2.0` |
| `kind` | `moemodels_deploybench_passport` |
| `passportId` | `deploybench-passport-sha256-` plus the canonical payload SHA-256 |
| `canonicalization` | Declared canonicalization, `RFC8785` |
| `payloadSha256` | SHA-256 of the canonical payload bytes |
| `classification` | Measured evidence with comparison eligibility fixed to false |
| `payload` | Producer, configuration digest, reproducibility assessment, and trials |
| `signatures` | Zero or more embedded operator-authorship signatures |

The payload retains each complete v0.1 endpoint trial. A trial contains run
identity, workload shape, request measurements, recomputable summaries, missing
context, and the default-deny privacy declaration.

## Configuration identity

The configuration digest covers these trial fields:

```text
endpoint origin
+ served model name
+ declared artifact repository and revision
+ declared runtime name and version
+ declared hardware and topology
+ request protocol and workload parameters
```

All trials in a Passport must have byte-equivalent canonical configuration
objects. Start/completion timestamps, run IDs, measurements, and summaries may
differ. Trial order does not affect Passport identity because packing sorts
trials by their canonical bytes before hashing.

The endpoint origin is retained and should be reviewed before publication. URL
credentials are rejected.

## Canonicalization and content identity

The implementation serializes JSON-compatible values deterministically:

- object keys are lexicographically sorted;
- array order is retained;
- UTF-8 is used for digest input;
- `undefined`, non-finite numbers, non-plain objects, and lone UTF-16 surrogates
  are rejected;
- negative zero follows JSON serialization and becomes `0`.

The implementation describes this as RFC 8785 JSON Canonicalization
Scheme-style serialization and declares `RFC8785` in the envelope. Consumers
should use the shipped verifier rather than reproducing identity from ordinary
pretty-printed JSON.

`payloadSha256` is the lowercase SHA-256 of the canonical payload. `passportId`
must contain that exact digest. `configurationSha256` is recomputed separately
from the shared configuration object.

## Reproducibility gates

Passport v0.2 evaluates seven gates:

| Gate | Requirement |
| --- | --- |
| `compatible_trials` | Every trial has an identical configuration identity |
| `minimum_trials` | At least three measured trials |
| `immutable_artifact_revision` | Every trial declares the same repository and a 40- or 64-character lowercase hexadecimal revision |
| `runtime_identity` | Runtime name and version are present |
| `infrastructure_identity` | Hardware and topology are present |
| `request_measurements` | Measurement counts reconcile with workload and summary counts |
| `privacy_boundary` | Prompt text, response text, and API keys are declared absent |

Passing all seven makes `payload.reproducibility.complete` true. It does not
make the Passport comparison eligible.

Three trials are a minimum protocol rule, not a statistical-power claim.

## Summary verification

The verifier validates each request record and recomputes every trial summary.
It checks, among other constraints:

- contiguous zero-based request indexes;
- successful and failed counts reconciling with attempts;
- successful requests having a 2xx status and no error code;
- failed requests retaining an error code and no TTFT;
- monotonic distribution percentiles;
- request and output-token throughput from the retained wall time and samples;
- stored summaries matching the canonical recomputation.

Missing token usage and missing content-bearing stream events remain explicit
`null` values. They are not replaced with zero.

## Signature semantics

Signing is optional. v0.2 accepts Ed25519 private keys and embeds:

- the public key in SPKI form;
- a SHA-256-derived key ID;
- the signed payload digest;
- the signature;
- a fixed authorship-only semantics statement.

The signed message is domain-separated with
`MOEMODELS_DEPLOYBENCH_PASSPORT_V0_2` and the payload digest. A passing embedded
signature is reported as:

```json
{
  "status": "valid_self_signed",
  "authorshipOnly": true,
  "trusted": false
}
```

The private key is read locally and is never written into the Passport. Trust
stores, key revocation, organizational identity, transparency logs, and
maintainer admission are outside v0.2.

## Privacy boundary

The endpoint runner stores neither prompt text, response text, nor API keys. It
does retain:

- endpoint origin;
- prompt SHA-256 and UTF-8 byte length;
- declared model and deployment identity;
- per-request timing, HTTP status, returned token counts, and output character
  counts.

A prompt digest may reveal a short or predictable prompt through guessing. It
is not anonymization. Operators must review Passports for private endpoint names
and sensitive derived metadata before sharing them.

## Verification interfaces

CLI:

```sh
npx moemodels verify passport.json --json
```

Node:

```ts
import { verifyEvidencePassport } from "@moemodels/bench";

const report = await verifyEvidencePassport(passport);
if (!report.valid) throw new Error(report.issues.join("\n"));
```

Browser:

```ts
import { verifyEvidencePassport } from "@moemodels/bench/browser";
```

GitHub Actions:

```yaml
- uses: SamSnead85/moemodels@v0
  with:
    passport: evidence/passport.json
```

The browser surface uses Web Crypto and excludes endpoint execution and private
key signing.

## Versioning

Any breaking change to canonical identity, required fields, signature message,
or verification semantics requires a new Passport schema version. Published
Passport bytes are immutable; corrections create another artifact that can
reference the previous Passport rather than rewriting it.

The Passport format is narrower than the complete DeployBench v0.1 protocol
draft. Future lifecycle bundles, runtime adapters, resource telemetry, quality
guardrails, and admission policies must not be back-claimed as properties of a
v0.2 Passport.
