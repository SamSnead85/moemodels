# `@moemodels/ingest`

Node-only, offline evidence adapters for MOEModels.ai. Version `0.1.0` accepts
aggregated JSON emitted by EleutherAI's `lm-evaluation-harness`, hashes the
original bytes, and converts supported fields into a deterministic `0.1.0`
staging envelope with JSON-pointer provenance. The importer has its own identity
(`moemodels-lm-eval-import-v0-1-0`); it does not claim that every input was
executed by the separately pinned v0.4.12 reference harness.

The adapter never fetches a URL, reads the clock or environment, executes task
configuration, or copies prompts and model responses. Files larger than 10 MiB
are rejected. Sample logs are intentionally excluded from v0.1.

```ts
import { normalizeLmEvalArtifact } from "@moemodels/ingest";

const normalized = normalizeLmEvalArtifact(bytes, {
  sourceId: "local-lm-eval-run",
  title: "Aggregated lm-eval result",
  publisher: "Run operator",
  url: "https://example.invalid/pinned/results.json",
  retrievedAt: "2026-08-03",
});
```

The output is deliberately not an accepted registry run. Aggregate lm-eval JSON
does not provide a structured hardware topology, so an import remains
`incomplete` until a reviewer attaches trustworthy execution metadata and the
full canonical fingerprint. Version 1 admission is one task per raw result;
multi-task imports remain valid staging envelopes but cannot be losslessly
admitted until the run-to-task model is expanded.

`license`, `licenseLocator`, `publishedAt`, and a more precise source `locator`
belong to the caller-supplied import metadata and remain in the staging source.
The shared evaluation registry's
raw-artifact contract intentionally stores only stable artifact identity; a
missing import license is retained as an ingestion diagnostic instead of being
silently inferred.

## First-party fixture

The test fixture is copied byte-for-byte from EleutherAI's MIT-licensed harness
repository at revision
`f4d4b3de3ee6741a7151a9fe74945ee515262f4c`:

- Upstream path: `tests/testdata/hellaswag-v0-res.json`
- Byte length: `196`
- SHA-256: `61b6de31be2962ce17f8a55a15b400f95a8752de81c496970942689386ebfa1b`
- Source: <https://github.com/EleutherAI/lm-evaluation-harness/blob/f4d4b3de3ee6741a7151a9fe74945ee515262f4c/tests/testdata/hellaswag-v0-res.json>
- License: <https://github.com/EleutherAI/lm-evaluation-harness/blob/f4d4b3de3ee6741a7151a9fe74945ee515262f4c/LICENSE.md>

That legacy artifact does not identify the evaluated model, harness run commit,
execution date, task filter, sample count, or hardware. The adapter preserves
those gaps as unknown and marks the record `fixture_only`; it is not eligible
for a leaderboard.
