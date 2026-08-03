# Security policy

## Current support status

MOEModels is experimental and has no supported production release or security
support SLA. The project has not claimed SOC 2, ISO 27001, HIPAA, or any other
certification or attestation.

The absence of a production release does not make vulnerabilities unimportant.
Please report issues that could affect users, contributors, evidence integrity,
credentials, dependencies, or release artifacts responsibly.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, post exploit details
in a discussion, or attach sensitive evidence to a public deployment-card issue.

Use GitHub's **Private vulnerability reporting** feature if it is enabled in the
repository Security tab. Otherwise, use a private contact method listed on the
repository owner's GitHub profile to request a secure reporting channel before
sending sensitive details. This file intentionally does not invent an
unmonitored security inbox.

Include, when possible:

- A clear description of the issue and affected component.
- Reproduction steps or a minimal proof of concept using synthetic data.
- Expected and observed behavior.
- Potential impact and required preconditions.
- Affected package versions, revisions, commands, or artifact shapes.
- Suggested mitigation, if known.
- Whether the issue has been disclosed anywhere else.

Remove real credentials, personal information, customer data, private prompts,
restricted model artifacts, and destructive payloads.

## Response and disclosure

Reports are handled on a best-effort basis while the project is pre-release. No
response or remediation deadline is promised. A maintainer may request more
information, confirm scope, coordinate a fix, and agree on a disclosure date.

Please allow a reasonable opportunity to investigate and address the issue
before public disclosure. The project will credit reporters when appropriate
and desired, but it does not currently operate a bug-bounty program.

## In scope

- A canonicalization discrepancy, collision, ambiguity, or parser differential
  that can give different Passport identities to equivalent content or the same
  identity to materially different content.
- A bypass of Passport payload SHA-256, Passport ID, configuration digest,
  structural validation, trial compatibility, or summary recomputation checks.
- Ed25519 signature forgery, key-ID confusion, signature-domain confusion, or a
  path that reports an invalid signature as valid.
- A bypass that changes or accepts `comparisonEligible` as true in Passport
  v0.2, or makes packing/signing imply trusted admission.
- Prompt, response, API-key, credential, environment, or private endpoint data
  leaking into runner, importer, CLI, Passport, log, or error output contrary to
  the documented boundary.
- Injection, request forgery, unsafe URL handling, path traversal, unsafe file
  overwrite, or execution of untrusted imported evidence.
- Malicious registry, evaluation, trial, or Passport input that bypasses strict
  validation and changes a security- or evidence-relevant result.
- Dependency, GitHub Action, package, or release-pipeline compromise with a
  demonstrated project impact.

## Usually handled publicly

The following normally belong in a regular issue unless they reveal an
exploitable security or evidence-integrity condition:

- Unsupported model facts or ordinary source corrections.
- Calculation disagreements where validation behaves as documented.
- Missing features or hardening proposals for an explicitly experimental
  component.
- Vulnerabilities in an unrelated upstream project without a demonstrated
  effect on this repository.

Do not include credentials, private infrastructure details, customer data, or a
working exploit when opening an ordinary issue.

## Operational boundaries

- `moemodels plan` and `fit` calculate a checkpoint-tensor residency floor. They
  do not inspect a cluster, load weights, establish runtime support, or certify
  a deployment.
- `moemodels run` sends the selected prompt to an endpoint supplied by the user.
  Treat that endpoint as untrusted and scope `MOEMODELS_BENCH_API_KEY` to the
  minimum required access.
- Endpoint trials and Passports retain endpoint origin, prompt SHA-256, and
  prompt byte length. A hash of a short or predictable prompt can be guessed and
  is not anonymization.
- A valid Passport establishes internal structure and content integrity only.
  It does not prove the declared checkpoint, runtime, hardware, topology, or
  measurement truth.
- An embedded Ed25519 signature is self-asserted authorship only. The verifier
  intentionally reports `trusted: false` without an external trust policy.

Never place real keys in issue forms, fixtures, prompts, logs, configuration
examples, or committed evidence.
