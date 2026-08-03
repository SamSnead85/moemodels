# MOEModels registry v1

`registry.json` is the canonical offline snapshot consumed by `@moemodels/core`
and the `moemodels` CLI. Every quantitative model or hardware field is a
claim: it is either `known` with one or more provenance references, or
`unknown` with an explicit reason and provenance for the reviewed artifact.

The registry deliberately does not contain estimated throughput, token costs,
concurrency, or runtime support. `artifactTensorBytes` is the byte total from a
pinned checkpoint manifest. It is useful for deterministic static residency
math, but is not a measurement of peak runtime memory.

Hardware memory is recorded as the vendor's advertised decimal GB and converted
by the engine with `1 GB = 1,000,000,000 bytes`. The default 13% reserve and
8-accelerator topology are transparent, user-adjustable methodology settings,
not sourced hardware claims.

Validate the snapshot from the repository root:

```sh
npm run registry:validate
```
