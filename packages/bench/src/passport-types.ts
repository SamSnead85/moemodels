import type { EndpointBenchmarkResult } from "./types.js";

export const EVIDENCE_PASSPORT_SCHEMA_VERSION = "0.2.0" as const;
export const EVIDENCE_PASSPORT_KIND = "moemodels_deploybench_passport" as const;
export const EVIDENCE_PASSPORT_CANONICALIZATION = "RFC8785" as const;
export const EVIDENCE_PASSPORT_REQUIRED_TRIALS = 3 as const;
export const EVIDENCE_PASSPORT_SIGNATURE_SEMANTICS =
  "Self-asserted operator authorship only. This signature does not verify the declared model artifact, runtime, hardware, topology, or measurement truth." as const;

export type ReproducibilityGateId =
  | "compatible_trials"
  | "minimum_trials"
  | "immutable_artifact_revision"
  | "runtime_identity"
  | "infrastructure_identity"
  | "request_measurements"
  | "privacy_boundary";

export interface ReproducibilityGate {
  id: ReproducibilityGateId;
  passed: boolean;
  detail: string;
}

export interface ReproducibilityAssessment {
  requiredTrials: typeof EVIDENCE_PASSPORT_REQUIRED_TRIALS;
  observedTrials: number;
  complete: boolean;
  gates: ReproducibilityGate[];
  missing: string[];
}

export interface EvidencePassportPayload {
  producer: {
    name: "@moemodels/bench";
    version: "0.1.0";
  };
  configurationSha256: string;
  reproducibility: ReproducibilityAssessment;
  trials: EndpointBenchmarkResult[];
}

export interface EvidencePassportSignature {
  kind: "operator_authorship";
  algorithm: "Ed25519";
  keyId: string;
  publicKeySpkiBase64: string;
  signedPayloadSha256: string;
  signatureBase64: string;
  semantics: typeof EVIDENCE_PASSPORT_SIGNATURE_SEMANTICS;
}

export interface DeployBenchEvidencePassport {
  schemaVersion: typeof EVIDENCE_PASSPORT_SCHEMA_VERSION;
  kind: typeof EVIDENCE_PASSPORT_KIND;
  passportId: string;
  canonicalization: typeof EVIDENCE_PASSPORT_CANONICALIZATION;
  payloadSha256: string;
  classification: {
    evidenceClass: "measured";
    comparisonEligible: false;
    reason: string;
  };
  payload: EvidencePassportPayload;
  signatures: EvidencePassportSignature[];
}

export interface EvidencePassportSignatureVerification {
  keyId: string;
  status: "valid_self_signed" | "invalid";
  authorshipOnly: true;
  trusted: false;
  issue: string | null;
}

export interface EvidencePassportVerification {
  valid: boolean;
  schemaValid: boolean;
  payloadDigestValid: boolean;
  passportIdValid: boolean;
  configurationDigestValid: boolean;
  summariesValid: boolean;
  compatibleTrials: boolean;
  reproducibilityClaimsValid: boolean;
  comparisonEligible: false;
  issues: string[];
  recomputedReproducibility: ReproducibilityAssessment | null;
  signatures: EvidencePassportSignatureVerification[];
}

export class EvidencePassportError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "EvidencePassportError";
    this.issues = issues;
  }
}
