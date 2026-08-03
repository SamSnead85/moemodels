import { canonicalSha256Hex, canonicalizeJson } from "./canonical.js";
import {
  EVIDENCE_PASSPORT_CANONICALIZATION,
  EVIDENCE_PASSPORT_KIND,
  EVIDENCE_PASSPORT_SCHEMA_VERSION,
  EvidencePassportError,
  type DeployBenchEvidencePassport,
  type EvidencePassportPayload,
} from "./passport-types.js";
import {
  assessEvidencePassportTrials,
  endpointBenchmarkConfiguration,
  validateEndpointBenchmarkResult,
  verifyEvidencePassport,
} from "./passport-verify.js";
import type { EndpointBenchmarkResult } from "./types.js";

const CLASSIFICATION_REASON =
  "The passport preserves direct endpoint measurements and reproducibility gates, but remains comparison ineligible until a separate MOEModels admission policy verifies the complete methodology and evidence context.";

export async function packEvidencePassport(
  inputTrials: readonly EndpointBenchmarkResult[],
): Promise<DeployBenchEvidencePassport> {
  if (inputTrials.length === 0) {
    throw new EvidencePassportError("At least one endpoint benchmark trial is required.");
  }
  const trialIssues = inputTrials.flatMap((trial, index) => {
    const result = validateEndpointBenchmarkResult(trial);
    return result.issues.map((issue) => `trial[${index}]${issue.slice(1)}`);
  });
  if (trialIssues.length > 0) {
    throw new EvidencePassportError("One or more endpoint trials failed validation.", trialIssues);
  }
  const runIds = inputTrials.map((trial) => trial.run.id);
  if (new Set(runIds).size !== runIds.length) {
    throw new EvidencePassportError("Every packed trial must have a distinct run id.");
  }

  const trials = [...inputTrials].sort((left, right) => {
    const leftCanonical = canonicalizeJson(left);
    const rightCanonical = canonicalizeJson(right);
    return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
  });
  const configuration = endpointBenchmarkConfiguration(trials[0] as EndpointBenchmarkResult);
  const compatible = trials.every(
    (trial) =>
      canonicalizeJson(endpointBenchmarkConfiguration(trial)) ===
      canonicalizeJson(configuration),
  );
  if (!compatible) {
    throw new EvidencePassportError(
      "Packed trials must share an identical endpoint, model, artifact, runtime, infrastructure, and workload configuration.",
    );
  }
  const payload: EvidencePassportPayload = {
    producer: { name: "@moemodels/bench", version: "0.1.0" },
    configurationSha256: await canonicalSha256Hex(configuration),
    reproducibility: assessEvidencePassportTrials(trials, compatible),
    trials,
  };
  const payloadSha256 = await canonicalSha256Hex(payload);
  return {
    schemaVersion: EVIDENCE_PASSPORT_SCHEMA_VERSION,
    kind: EVIDENCE_PASSPORT_KIND,
    passportId: `deploybench-passport-sha256-${payloadSha256}`,
    canonicalization: EVIDENCE_PASSPORT_CANONICALIZATION,
    payloadSha256,
    classification: {
      evidenceClass: "measured",
      comparisonEligible: false,
      reason: CLASSIFICATION_REASON,
    },
    payload,
    signatures: [],
  };
}

export async function parseEvidencePassport(
  input: unknown,
): Promise<DeployBenchEvidencePassport> {
  const verification = await verifyEvidencePassport(input);
  if (!verification.valid) {
    throw new EvidencePassportError("Evidence passport verification failed.", verification.issues);
  }
  return input as DeployBenchEvidencePassport;
}

export function serializeEvidencePassport(
  passport: DeployBenchEvidencePassport,
): string {
  return `${canonicalizeJson(passport)}\n`;
}
