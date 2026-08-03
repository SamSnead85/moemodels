# MOEModels evaluations v1

`@moemodels/evaluations-v1` is the versioned evidence envelope for model
evaluations. It keeps two categories deliberately separate:

- `reportedClaims` are first-party, owner-reported numbers. They preserve the
  provider's metric label and available settings, enumerate missing context,
  set `executionArtifactDigest` to `null`, and are never comparison eligible.
- `runs` are normalized results produced by a pinned adapter with raw artifacts
  and execution metadata. This first snapshot contains no normalized runs.

The package includes 15 reported claims across the five artifacts in the
MOEModels registry. A claim marked `artifact_snapshot_associated` appears in a
model card stored at the registry's pinned artifact revision. This is stronger
than a model-name citation, but it is not proof that the provider evaluated the
exact tensor bytes at that revision. `model_name_only` means even that snapshot
association is unavailable.

## Adapter pin

The declared adapter is EleutherAI's `lm-eval` v0.4.12 at commit
`6d642546f4688648fced259eb3302efd36ece5af`. Its status is
`pinned_not_executed`: the pin is reproducibility metadata, not a claim that the
current owner-reported values were produced by lm-eval.

## Import

```js
import evaluations from "@moemodels/evaluations-v1" with { type: "json" };

console.log(evaluations.reportedClaims.length); // 15
console.log(evaluations.runs.length); // 0
```

The JSON Schema is exported as `@moemodels/evaluations-v1/schema.json`. Both
JSON files can be checked for syntax with Node:

```sh
node -e 'for (const file of ["schema.json", "evaluations.json"]) JSON.parse(require("node:fs").readFileSync(file, "utf8"))'
```

## Comparison fingerprint

A normalized run is admitted only with an exact registry artifact, a referenced
`lm_eval_results` digest, a canonical `run_manifest`, at least one
filter-qualified metric with standard error and sample count, and the complete
fingerprint required by `schema.json`.
Fingerprint hashes use the following normative encoding:

- Structured reasoning and sampling configurations use RFC 8785 JSON
  Canonicalization Scheme bytes encoded as UTF-8, then SHA-256.
- Chat-template and system-prompt hashes cover their exact UTF-8 bytes. An
  absent value is represented by the four UTF-8 bytes for JSON `null`.
- Task hashes and raw-artifact hashes cover their exact published bytes.
- `acceleratorId` must resolve in MOEModels hardware registry v1.0.0. Runtime
  names, precision labels, and interconnects use lowercase canonical identifiers;
  versions remain exact upstream version strings.

Changing any of these bytes or identities produces a different fingerprint.
An ineligible normalized run must carry at least one explicit exclusion reason;
an eligible run cannot carry one.

Registry v1 admits one benchmark task per raw result artifact. A multi-task
aggregate may be imported into a staging envelope, but it must not be duplicated
or split into published runs because doing so would break raw-artifact identity.

Owner-reported values must not be ranked or merged with normalized runs. A
future comparison pipeline should require a normalized run, immutable raw
artifact hashes, a verified execution artifact digest, and compatible task and
harness settings.
