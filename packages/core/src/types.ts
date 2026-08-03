export interface ProvenanceRef {
  sourceId: string;
  locator?: string;
}

export interface KnownClaim<T> {
  status: "known";
  value: T;
  provenance: ProvenanceRef[];
}

export interface UnknownClaim {
  status: "unknown";
  reason: string;
  provenance: ProvenanceRef[];
}

export type Claim<T> = KnownClaim<T> | UnknownClaim;

export interface RegistrySource {
  id: string;
  title: string;
  publisher: string;
  url: string;
  retrievedAt: string;
  publishedAt?: string;
  locator?: string;
}

export interface ModelArtifact {
  repository: string;
  revision: string;
  format: "safetensors";
  manifestUrl: string;
  provenance: ProvenanceRef[];
}

export interface ModelClaims {
  totalParameters: Claim<number>;
  activeParameters: Claim<number>;
  artifactTensorBytes: Claim<number>;
  contextTokens: Claim<number>;
  routedExperts: Claim<number>;
  expertsPerToken: Claim<number>;
  nativeWeightFormat: Claim<string>;
  license: Claim<string>;
}

export interface ModelRecord {
  id: string;
  name: string;
  provider: string;
  provenance: ProvenanceRef[];
  artifact: ModelArtifact;
  claims: ModelClaims;
}

export interface HardwareClaims {
  memoryGigabytes: Claim<number>;
}

export interface HardwareRecord {
  id: string;
  name: string;
  vendor: string;
  aliases: string[];
  provenance: ProvenanceRef[];
  claims: HardwareClaims;
}

export interface RegistryMethodology {
  capacityUnit: "decimal-gigabytes";
  defaultReserveBasisPoints: number;
  defaultAcceleratorsPerNode: number;
}

export type CompatibilityStatus = "supported" | "unsupported" | "unknown";
export type CompatibilityEvidenceLevel =
  | "owner_declared"
  | "runtime_implemented"
  | "reproduced"
  | "known_issue"
  | "unsupported"
  | "unknown";

export interface CompatibilityRecord {
  id: string;
  modelId: string;
  hardwareId: string;
  framework: string;
  status: CompatibilityStatus;
  evidenceLevel: CompatibilityEvidenceLevel;
  reason: string;
  provenance: ProvenanceRef[];
}

export interface Registry {
  $schema: string;
  registryVersion: "1.0.0";
  generatedAt: string;
  methodology: RegistryMethodology;
  sources: RegistrySource[];
  models: ModelRecord[];
  hardware: HardwareRecord[];
  compatibility: CompatibilityRecord[];
}
