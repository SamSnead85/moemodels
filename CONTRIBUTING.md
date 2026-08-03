# Contributing to MOEModels.ai

Thank you for helping build a more inspectable evidence layer for expert-routed
models. Accuracy, reproducibility, and clear uncertainty are part of the product,
not administrative details.

This repository is at an early prototype stage. Before proposing a large feature,
open an issue describing the concrete user decision it improves. Small fixes,
accessibility improvements, source corrections, and documentation clarifications
may go directly to a pull request.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- Correct or improve a sourced model fact.
- Propose a new model record using the model-record issue form.
- Submit a reproducible deployment card using the deployment-card issue form.
- Improve calculation clarity, conservative assumptions, or test coverage.
- Help shape benchmark evidence packs through version-gated importers, run
  fingerprints, validation fixtures, and artifact-integrity checks.
- Improve accessibility, responsive behavior, documentation, and performance.
- Identify conflicts, deprecations, broken sources, or unsupported claims.

The versioned model and evaluation registries, deterministic residency core,
CLI, endpoint runner, Evidence Passport, SDK, MCP server, and lm-eval staging
importer are present in this repository. Accepted normalized benchmark runs,
full runtime lifecycle adapters, and a measured runtime/hardware matrix remain
roadmap work. Keep shipped behavior and proposed capabilities distinct.

## Contribution workflow

1. Search existing issues and pull requests.
2. Use the relevant issue form for model records or deployment cards. Open a
   design issue before an architectural or dependency-heavy change.
3. Create a focused branch from the repository's current default branch.
4. Install dependencies with `npm ci`.
5. Make the smallest coherent change that solves the issue.
6. Run the applicable validation commands.
7. Open a pull request using the repository template and link the issue.

Do not mix unrelated refactors, protocol changes, and data changes in one pull
request.

## Provenance requirements

Every material model or hardware claim must include enough context for a reviewer
to find and assess the evidence.

Required where applicable:

- Exact model family and released version.
- Exact repository revision, checkpoint identifier, artifact name, and hash.
- Claim field, value, and unit without silent normalization.
- Source title, source owner, direct URL, and source locator such as a heading,
  table, file path, or line range.
- Publication/release date and retrieval date.
- Evidence class: sourced fact, measured evidence, calculated estimate, or
  inference.
- Conflicting values and unresolved unknowns.
- License source and scope when making access or commercial-use statements.

Prefer first-party model cards, technical reports, repositories, artifact
manifests, licenses, and manufacturer specifications. Secondary sources can help
locate evidence but should not silently replace the primary source.

Do not submit:

- Search-result snippets as evidence.
- Screenshots without a stable source and text locator.
- Aggregated benchmark numbers without their original run configuration.
- Marketing language recast as independent measurement.
- Guessed values presented as facts.
- Long copied passages from copyrighted sources.

Use `unknown`, a range, or an explicit inference when the evidence does not
support a precise value.

## Sourced model records

Start with the
[sourced model record form](.github/ISSUE_TEMPLATE/sourced-model-record.yml).
A model record should be version-specific. Family-level claims must not be
silently applied to every checkpoint.

A review-ready proposal normally covers:

- Identity and release lineage.
- Total and active parameters, expert topology, and context limits.
- Exact weight artifacts and supported/native precision.
- License and access classification with a direct license source.
- Runtime support only when an exact runtime/version source exists.
- Known limitations and meaningful conflicts.

The canonical catalog is versioned structured data. Acceptance of an issue does
not make a record verified; every registry change still requires strict schema
and semantic validation, provenance review, and focused tests.

## Reproducible deployment cards

Start with the
[reproducible deployment card form](.github/ISSUE_TEMPLATE/reproducible-deployment-card.yml).
A deployment card documents an observed configuration. It is not a universal
hardware recommendation.

Include:

- Model artifact/checkpoint and cryptographic hash when available.
- Runtime name, exact version or commit, and launch command/configuration.
- Precision and quantization method, version, calibration details, and artifact.
- GPU/accelerator count, SKU, VRAM, topology, interconnect, CPU, RAM, and storage.
- Driver, accelerator toolkit, kernel/OS, container image digest, and relevant
  environment versions.
- Input/output token distributions, context, batching, concurrency, warm-up,
  caching, and request shape.
- Measurement definitions, run count, summary statistics, variability, failures,
  and raw machine-readable artifacts.
- Execution date, operator, known limitations, and reproduction instructions.

Remove secrets, tokens, internal hostnames, customer data, and proprietary prompt
content before attaching logs or configuration. Do not mark estimated output as a
measured run.

## Code and interface changes

- Keep TypeScript strict and avoid `any` unless an interface boundary requires it.
- Prefer deterministic functions for calculations and add focused tests for
  formulas and edge cases.
- Do not add a dependency when a small, maintainable implementation is sufficient.
- Label all fixtures and simulated metrics as demonstration data.
- Do not introduce credentials, private endpoints, analytics keys, or unreviewed
  external scripts.

## Validation

Run:

```bash
npm test
```

Add or run focused tests appropriate to the change. The current suite verifies
the public export boundary, registry/schema validation, integer residency, CLI
and package behavior, Passport integrity, and clean tarball installation.
Calculation, data, and protocol changes should add narrower unit or integration
coverage rather than relying only on the broad suite.

For calculation or data changes, include representative inputs, expected outputs,
units, boundary cases, and the source/assumption registry used.

## Pull-request expectations

A pull request should:

- Explain the user or evidence problem.
- Link the relevant issue.
- Separate current behavior from proposed behavior.
- List sources and evidence classes for changed claims.
- State validation performed and any failures or omissions.
- Identify compatibility, security, data-quality, or maintenance risks.
- Avoid claims of production readiness, certification, or benchmark verification
  that the repository cannot substantiate.

AI-assisted contributions are welcome, but the contributor is responsible for
every claim, source, license, configuration, and line of code submitted. Review
generated citations and calculations against the original material.

## Review and acceptance

Maintainers may request a narrower change, stronger primary evidence, raw
artifacts, revised labels, additional tests, or removal of unsupported claims.
Opening an issue or pull request does not guarantee inclusion.

Documentation and code contributions are accepted under the repository's
[Apache License 2.0](LICENSE). Do not contribute material you do not have the
right to license.
