import type { HardwareRecord, ModelRecord } from "./types.js";

export const DECIMAL_GIGABYTE_BYTES = 1_000_000_000n;
export const DEFAULT_RESERVE_BASIS_POINTS = 1300;
export const DEFAULT_ACCELERATORS_PER_NODE = 8;

export interface ResidencyOptions {
  reserveBasisPoints?: number;
  acceleratorsPerNode?: number;
  requestedAccelerators?: number;
}

export interface KnownResidencyFit {
  status: "known";
  method: "pinned-artifact-static-residency";
  artifactTensorBytes: string;
  advertisedMemoryBytesPerAccelerator: string;
  usableMemoryBytesPerAccelerator: string;
  reserveBasisPoints: number;
  acceleratorsPerNode: number;
  minimumAccelerators: number;
  minimumNodes: number;
  topologyRoundedAccelerators: number;
  requestedAccelerators: number | null;
  fitsRequestedAccelerators: boolean | null;
  runtimeCompatibility: "unknown";
  limitations: readonly string[];
}

export interface UnknownResidencyFit {
  status: "unknown";
  reason: string;
  runtimeCompatibility: "unknown";
}

export type ResidencyFit = KnownResidencyFit | UnknownResidencyFit;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function reserveBasisPoints(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9999) {
    throw new RangeError("reserveBasisPoints must be an integer from 0 through 9999.");
  }
  return value;
}

export function ceilDivide(dividend: bigint, divisor: bigint): bigint {
  if (dividend < 0n) throw new RangeError("dividend cannot be negative.");
  if (divisor <= 0n) throw new RangeError("divisor must be positive.");
  return (dividend + divisor - 1n) / divisor;
}

export function calculateIntegerResidency(input: {
  artifactTensorBytes: number | bigint;
  memoryGigabytes: number | bigint;
  reserveBasisPoints?: number;
  acceleratorsPerNode?: number;
  requestedAccelerators?: number;
}): KnownResidencyFit {
  const artifactBytes = BigInt(input.artifactTensorBytes);
  const memoryGigabytes = BigInt(input.memoryGigabytes);
  if (artifactBytes <= 0n) throw new RangeError("artifactTensorBytes must be positive.");
  if (memoryGigabytes <= 0n) throw new RangeError("memoryGigabytes must be positive.");

  const reserve = reserveBasisPoints(input.reserveBasisPoints ?? DEFAULT_RESERVE_BASIS_POINTS);
  const perNode = positiveInteger(
    input.acceleratorsPerNode ?? DEFAULT_ACCELERATORS_PER_NODE,
    "acceleratorsPerNode",
  );
  const requested =
    input.requestedAccelerators === undefined
      ? null
      : positiveInteger(input.requestedAccelerators, "requestedAccelerators");
  const advertisedBytes = memoryGigabytes * DECIMAL_GIGABYTE_BYTES;
  const usableBytes = (advertisedBytes * BigInt(10_000 - reserve)) / 10_000n;
  if (usableBytes <= 0n) throw new RangeError("reserve leaves no usable accelerator memory.");

  const minimum = ceilDivide(artifactBytes, usableBytes);
  const minimumNodes = ceilDivide(minimum, BigInt(perNode));
  const topologyRounded = minimumNodes * BigInt(perNode);
  const minimumNumber = Number(minimum);
  const minimumNodesNumber = Number(minimumNodes);
  const topologyNumber = Number(topologyRounded);
  if (
    !Number.isSafeInteger(minimumNumber) ||
    !Number.isSafeInteger(minimumNodesNumber) ||
    !Number.isSafeInteger(topologyNumber)
  ) {
    throw new RangeError("calculated accelerator count exceeds the safe integer range.");
  }

  return {
    status: "known",
    method: "pinned-artifact-static-residency",
    artifactTensorBytes: artifactBytes.toString(),
    advertisedMemoryBytesPerAccelerator: advertisedBytes.toString(),
    usableMemoryBytesPerAccelerator: usableBytes.toString(),
    reserveBasisPoints: reserve,
    acceleratorsPerNode: perNode,
    minimumAccelerators: minimumNumber,
    minimumNodes: minimumNodesNumber,
    topologyRoundedAccelerators: topologyNumber,
    requestedAccelerators: requested,
    fitsRequestedAccelerators: requested === null ? null : BigInt(requested) * usableBytes >= artifactBytes,
    runtimeCompatibility: "unknown",
    limitations: [
      "Static checkpoint tensor bytes only; runtime allocations are not included.",
      "Framework, kernel, interconnect, quantization, and sharding support are not asserted.",
      "KV cache, activations, routing buffers, allocator fragmentation, and host memory are not modeled.",
    ],
  };
}

export function calculateResidencyFit(
  model: ModelRecord,
  hardware: HardwareRecord,
  options: ResidencyOptions = {},
): ResidencyFit {
  const artifactBytes = model.claims.artifactTensorBytes;
  if (artifactBytes.status === "unknown") {
    return {
      status: "unknown",
      reason: `Artifact tensor bytes are unknown for ${model.name}: ${artifactBytes.reason}`,
      runtimeCompatibility: "unknown",
    };
  }
  const memory = hardware.claims.memoryGigabytes;
  if (memory.status === "unknown") {
    return {
      status: "unknown",
      reason: `Advertised memory is unknown for ${hardware.name}: ${memory.reason}`,
      runtimeCompatibility: "unknown",
    };
  }
  return calculateIntegerResidency({
    artifactTensorBytes: artifactBytes.value,
    memoryGigabytes: memory.value,
    ...(options.reserveBasisPoints === undefined
      ? {}
      : { reserveBasisPoints: options.reserveBasisPoints }),
    ...(options.acceleratorsPerNode === undefined
      ? {}
      : { acceleratorsPerNode: options.acceleratorsPerNode }),
    ...(options.requestedAccelerators === undefined
      ? {}
      : { requestedAccelerators: options.requestedAccelerators }),
  });
}
