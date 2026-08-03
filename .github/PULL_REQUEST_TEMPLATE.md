## Summary

<!-- What changed? Keep this concrete and scoped. -->

## Why

<!-- Which user decision, evidence gap, bug, or maintenance problem does this solve? -->

Closes #

## Current behavior and boundary

<!--
Describe what exists after this change. Separate shipped behavior from roadmap
ideas. Registry v1, the deterministic residency core, CLI, endpoint runner, and
Evidence Passport are present. Do not imply a measured corpus, trusted record,
production-ready deployment, or certification unless the repository proves it.
-->

## Evidence and provenance

<!-- Delete this section only when no factual, data, or calculation claim changes. -->

| Claim or field | Evidence class | Exact source / locator | Retrieved or run date |
| --- | --- | --- | --- |
|  | Sourced / Measured / Calculated / Inferred |  |  |

Model/checkpoint, runtime, quantization, hardware, and artifact identifiers:

<!-- Include exact versions and hashes where applicable. State unknowns. -->

## Validation performed

- [ ] `npm test`
- [ ] `npm run check:public-boundary`
- [ ] Focused tests were added or run where practical.
- [ ] Calculation units, boundaries, and representative cases were checked.

Results, failures, and validation not performed:

<!--
Be explicit. The suite covers the export boundary, registry/schema, residency,
CLI, Passport, SDK/MCP, and package-installation checks; list focused validation
that was omitted.
-->

## Risks and follow-up

<!-- Compatibility, data quality, security, performance, maintenance, or roadmap follow-up. -->

## Contributor checklist

- [ ] The change is focused and does not include unrelated refactoring.
- [ ] Reported, measured, calculated, inferred, and demonstration values are visibly distinct.
- [ ] New or changed facts use primary sources where available and include direct locators.
- [ ] Unknown or conflicting values are preserved instead of guessed.
- [ ] Benchmark evidence includes exact model artifact, harness/task/runtime
      configuration, and raw artifact hashes where applicable.
- [ ] Deployment measurements include sufficient configuration and raw artifacts to review.
- [ ] No credentials, private endpoints, customer data, or restricted artifacts are included.
- [ ] I have the right to submit this code, documentation, data, and attached artifacts under the repository license.
- [ ] I have not claimed endpoint stability, production readiness, benchmark
      verification, or certification without evidence.
