import { calculateResidencyFit, type ResidencyFit } from "./residency.js";
import type {
  CompatibilityRecord,
  HardwareRecord,
  ModelRecord,
} from "./types.js";

export type AvailabilityTarget = "single" | "ha";
export type EvidenceClass = "sourced" | "calculated" | "measured" | "unknown";
export type PlanDimensionStatus = "blocked" | "conditional" | "unknown";
export type ValidationGateStatus = "blocked" | "calculated_pass" | "required";

export interface WorkloadProfile {
  inputTokens: number;
  outputTokens: number;
  concurrency: number;
  targetTtftMs: number;
  targetInterTokenMs: number;
  availability: AvailabilityTarget;
}

export interface DeploymentPlanInput {
  model: ModelRecord;
  hardware: HardwareRecord;
  compatibility: readonly CompatibilityRecord[];
  requestedAccelerators: number;
  acceleratorsPerNode: number;
  reserveBasisPoints: number;
  runtime?: string;
  workload: WorkloadProfile;
}

export interface PlanDimension {
  status: PlanDimensionStatus;
  evidenceClass: EvidenceClass;
  summary: string;
  known: readonly string[];
  unknown: readonly string[];
}

export interface ValidationGate {
  id:
    | "artifact_integrity"
    | "static_residency"
    | "runtime_load"
    | "memory_envelope"
    | "workload_sla"
    | "routing_health"
    | "economics_resilience";
  order: number;
  status: ValidationGateStatus;
  title: string;
  objective: string;
  acceptanceCriteria: readonly string[];
  requiredEvidence: readonly string[];
}

export interface DeploymentValidationPlan {
  schemaVersion: "1.0.0";
  kind: "deployment_validation_plan";
  scenarioKey: string;
  artifact: {
    modelId: string;
    modelName: string;
    repository: string;
    revision: string;
    manifestUrl: string;
  };
  target: {
    hardwareId: string;
    hardwareName: string;
    runtime: string;
    requestedAccelerators: number;
    acceleratorsPerNode: number;
    reserveBasisPoints: number;
  };
  workload: WorkloadProfile;
  evidencePolicy: {
    resultClass: "calculated";
    measuredPerformanceAvailable: false;
    statement: string;
  };
  readiness: {
    status: "blocked" | "validation_required";
    reason: string;
    staticResidency: "pass" | "fail" | "unknown";
    runtimeCompatibility: "supported" | "unsupported" | "unknown";
  };
  dimensions: {
    load: PlanDimension;
    run: PlanDimension;
    scale: PlanDimension;
    economics: PlanDimension;
  };
  risks: readonly string[];
  validationGates: readonly ValidationGate[];
  nextAction: {
    code: "increase_capacity" | "execute_validation" | "resolve_artifact_size";
    summary: string;
  };
  reproducibility: {
    cli: string;
    apiPath: string;
    assumptions: readonly string[];
  };
}

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

function runtimeName(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) return "unspecified";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new RangeError(
      "runtime must be 1–64 lowercase letters, numbers, periods, underscores, or hyphens.",
    );
  }
  return normalized;
}

function compatibilityFor(
  records: readonly CompatibilityRecord[],
  modelId: string,
  hardwareId: string,
  runtime: string,
): CompatibilityRecord | undefined {
  return records.find(
    (record) =>
      record.modelId === modelId &&
      record.hardwareId === hardwareId &&
      (runtime === "unspecified" || record.framework.toLowerCase() === runtime),
  );
}

function staticResidencyStatus(fit: ResidencyFit): "pass" | "fail" | "unknown" {
  if (fit.status === "unknown" || fit.fitsRequestedAccelerators === null) return "unknown";
  return fit.fitsRequestedAccelerators ? "pass" : "fail";
}

function shellToken(value: string): string {
  return /^[a-zA-Z0-9._/@:-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function query(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function blockedOrRequired(
  staticStatus: "pass" | "fail" | "unknown",
): "blocked" | "required" {
  return staticStatus === "fail" ? "blocked" : "required";
}

function buildValidationGates(
  input: DeploymentPlanInput,
  fit: ResidencyFit,
  staticStatus: "pass" | "fail" | "unknown",
  runtime: string,
): readonly ValidationGate[] {
  const downstreamStatus = blockedOrRequired(staticStatus);
  const staticAcceptance =
    fit.status === "known"
      ? `Checkpoint tensor bytes fit inside ${input.requestedAccelerators} accelerator(s) after a ${(input.reserveBasisPoints / 100).toFixed(2)}% reserve.`
      : "Establish exact checkpoint tensor bytes before attempting a capacity verdict.";

  return [
    {
      id: "artifact_integrity",
      order: 1,
      status: "required",
      title: "Verify the artifact",
      objective: "Bind every result to the exact immutable checkpoint bytes under evaluation.",
      acceptanceCriteria: [
        `Resolve ${input.model.artifact.repository}@${input.model.artifact.revision}.`,
        "Record manifest and checkpoint digests before execution.",
      ],
      requiredEvidence: ["artifact manifest", "revision identity", "content digests"],
    },
    {
      id: "static_residency",
      order: 2,
      status: staticStatus === "pass" ? "calculated_pass" : staticStatus === "fail" ? "blocked" : "required",
      title: "Clear the static residency floor",
      objective: "Reject topologies that cannot hold the pinned checkpoint tensor bytes.",
      acceptanceCriteria: [staticAcceptance],
      requiredEvidence: ["artifact tensor bytes", "advertised accelerator memory", "declared reserve"],
    },
    {
      id: "runtime_load",
      order: 3,
      status: downstreamStatus,
      title: "Prove runtime load compatibility",
      objective: `Load the exact artifact with ${runtime} on the declared topology.`,
      acceptanceCriteria: [
        "Process reaches a ready state without unsupported-architecture or out-of-memory errors.",
        "Record runtime, container, kernels, drivers, sharding, precision, and startup command.",
      ],
      requiredEvidence: ["runtime logs", "environment manifest", "startup result"],
    },
    {
      id: "memory_envelope",
      order: 4,
      status: downstreamStatus,
      title: "Measure the complete memory envelope",
      objective: "Replace the static lower bound with observed resident and peak memory.",
      acceptanceCriteria: [
        "Capture idle, warm, and peak accelerator and host memory.",
        `Exercise ${input.workload.inputTokens.toLocaleString("en-US")} input and ${input.workload.outputTokens.toLocaleString("en-US")} output tokens at concurrency ${input.workload.concurrency}.`,
        "Retain allocator, KV-cache, activation, routing-buffer, and fragmentation evidence.",
      ],
      requiredEvidence: ["memory telemetry", "workload manifest", "raw time series"],
    },
    {
      id: "workload_sla",
      order: 5,
      status: downstreamStatus,
      title: "Replay the target workload",
      objective: "Measure the latency and throughput frontier under the stated workload.",
      acceptanceCriteria: [
        `P95 time to first token is at or below ${input.workload.targetTtftMs} ms.`,
        `P95 inter-token latency is at or below ${input.workload.targetInterTokenMs} ms.`,
        `Sustain concurrency ${input.workload.concurrency} without request loss or invalid output.`,
      ],
      requiredEvidence: ["request-level timings", "throughput series", "error and quality results"],
    },
    {
      id: "routing_health",
      order: 6,
      status: downstreamStatus,
      title: "Inspect expert routing health",
      objective: "Expose MoE-specific imbalance and communication bottlenecks hidden by aggregate throughput.",
      acceptanceCriteria: [
        "Report expert-load distribution, hot and dead experts, and dropped-token behavior.",
        "Quantify routing and all-to-all communication share where runtime telemetry permits.",
      ],
      requiredEvidence: ["expert counters", "routing telemetry", "communication trace"],
    },
    {
      id: "economics_resilience",
      order: 7,
      status: downstreamStatus,
      title: "Validate economics and resilience",
      objective: "Attach cost and failure behavior to successful workload outcomes.",
      acceptanceCriteria: [
        "Report infrastructure cost per one million successful output tokens.",
        input.workload.availability === "ha"
          ? "Demonstrate redundant service during a worker or node interruption."
          : "Record restart time and data-plane interruption for one controlled worker failure.",
      ],
      requiredEvidence: ["price assumptions", "successful-token count", "failure timeline"],
    },
  ];
}

export function buildDeploymentPlan(input: DeploymentPlanInput): DeploymentValidationPlan {
  const requestedAccelerators = positiveInteger(
    input.requestedAccelerators,
    "requestedAccelerators",
  );
  const acceleratorsPerNode = positiveInteger(
    input.acceleratorsPerNode,
    "acceleratorsPerNode",
  );
  const reserve = reserveBasisPoints(input.reserveBasisPoints);
  const runtime = runtimeName(input.runtime);
  const workload: WorkloadProfile = {
    inputTokens: positiveInteger(input.workload.inputTokens, "workload.inputTokens"),
    outputTokens: positiveInteger(input.workload.outputTokens, "workload.outputTokens"),
    concurrency: positiveInteger(input.workload.concurrency, "workload.concurrency"),
    targetTtftMs: positiveInteger(input.workload.targetTtftMs, "workload.targetTtftMs"),
    targetInterTokenMs: positiveInteger(
      input.workload.targetInterTokenMs,
      "workload.targetInterTokenMs",
    ),
    availability: input.workload.availability,
  };
  if (workload.availability !== "single" && workload.availability !== "ha") {
    throw new RangeError("workload.availability must be single or ha.");
  }

  const fit = calculateResidencyFit(input.model, input.hardware, {
    requestedAccelerators,
    acceleratorsPerNode,
    reserveBasisPoints: reserve,
  });
  const staticStatus = staticResidencyStatus(fit);
  const compatibility = compatibilityFor(
    input.compatibility,
    input.model.id,
    input.hardware.id,
    runtime,
  );
  const runtimeCompatibility = compatibility?.status ?? "unknown";
  const staticBlocked = staticStatus === "fail";
  const compatibilityBlocked = runtimeCompatibility === "unsupported";
  const readinessBlocked = staticBlocked || compatibilityBlocked;

  const scenarioKey = [
    input.model.id,
    input.hardware.id,
    runtime,
    `${requestedAccelerators}x${acceleratorsPerNode}`,
    `r${reserve}`,
    `i${workload.inputTokens}`,
    `o${workload.outputTokens}`,
    `c${workload.concurrency}`,
    `t${workload.targetTtftMs}`,
    `p${workload.targetInterTokenMs}`,
    workload.availability,
  ].join("--");

  const cliArguments = [
    "moemodels plan",
    shellToken(input.model.id),
    shellToken(input.hardware.id),
    `--devices ${requestedAccelerators}`,
    `--devices-per-node ${acceleratorsPerNode}`,
    `--reserve-bps ${reserve}`,
    `--runtime ${shellToken(runtime)}`,
    `--input-tokens ${workload.inputTokens}`,
    `--output-tokens ${workload.outputTokens}`,
    `--concurrency ${workload.concurrency}`,
    `--target-ttft-ms ${workload.targetTtftMs}`,
    `--target-inter-token-ms ${workload.targetInterTokenMs}`,
    `--availability ${workload.availability}`,
    "--json",
  ];
  const apiParameters = {
    model: input.model.id,
    hardware: input.hardware.id,
    devices: requestedAccelerators,
    devicesPerNode: acceleratorsPerNode,
    reserveBps: reserve,
    runtime,
    inputTokens: workload.inputTokens,
    outputTokens: workload.outputTokens,
    concurrency: workload.concurrency,
    targetTtftMs: workload.targetTtftMs,
    targetInterTokenMs: workload.targetInterTokenMs,
    availability: workload.availability,
  };

  const staticKnown =
    fit.status === "known"
      ? [
          `${fit.minimumAccelerators} accelerator(s) are the mathematical checkpoint-residency minimum.`,
          `${fit.topologyRoundedAccelerators} accelerator(s) are required after ${acceleratorsPerNode}-device node rounding.`,
        ]
      : [];
  const staticUnknown =
    fit.status === "known"
      ? [...fit.limitations]
      : [fit.reason, "Runtime compatibility and execution behavior remain unknown."];

  const nextAction =
    fit.status === "unknown"
      ? {
          code: "resolve_artifact_size" as const,
          summary: "Resolve and verify exact checkpoint tensor bytes before selecting hardware.",
        }
      : staticBlocked
        ? {
            code: "increase_capacity" as const,
            summary: `Increase the target to at least ${fit.minimumAccelerators} accelerator(s); use ${fit.topologyRoundedAccelerators} for complete ${acceleratorsPerNode}-device nodes.`,
          }
        : {
            code: "execute_validation" as const,
            summary: "Execute the ordered validation gates; static residency alone is not a deployment approval.",
          };

  return {
    schemaVersion: "1.0.0",
    kind: "deployment_validation_plan",
    scenarioKey,
    artifact: {
      modelId: input.model.id,
      modelName: input.model.name,
      repository: input.model.artifact.repository,
      revision: input.model.artifact.revision,
      manifestUrl: input.model.artifact.manifestUrl,
    },
    target: {
      hardwareId: input.hardware.id,
      hardwareName: input.hardware.name,
      runtime,
      requestedAccelerators,
      acceleratorsPerNode,
      reserveBasisPoints: reserve,
    },
    workload,
    evidencePolicy: {
      resultClass: "calculated",
      measuredPerformanceAvailable: false,
      statement:
        "This plan contains a deterministic static-residency calculation and an execution protocol. It contains no measured performance result.",
    },
    readiness: {
      status: readinessBlocked ? "blocked" : "validation_required",
      reason: staticBlocked
        ? "The requested topology fails the static checkpoint-residency floor."
        : compatibilityBlocked
          ? `The registry marks ${runtime} unsupported for this exact model and hardware target.`
          : "Static residency is not a runtime, performance, scale, or economics certification.",
      staticResidency: staticStatus,
      runtimeCompatibility,
    },
    dimensions: {
      load: {
        status: readinessBlocked ? "blocked" : "conditional",
        evidenceClass: fit.status === "known" ? "calculated" : "unknown",
        summary:
          staticStatus === "pass"
            ? "The checkpoint clears the static residency floor; an instrumented runtime load is still required."
            : staticStatus === "fail"
              ? "The requested topology cannot hold the static checkpoint tensors under the declared reserve."
              : "Checkpoint residency cannot be calculated from the current record.",
        known: staticKnown,
        unknown: staticUnknown,
      },
      run: {
        status: readinessBlocked ? "blocked" : "unknown",
        evidenceClass: "unknown",
        summary: "Latency, throughput, quality retention, and complete memory are not measured.",
        known: [],
        unknown: [
          "runtime load success",
          "peak resident memory and KV capacity",
          "P95 time to first token and inter-token latency",
          "quality retention under the chosen serving configuration",
        ],
      },
      scale: {
        status: readinessBlocked ? "blocked" : "unknown",
        evidenceClass: "unknown",
        summary: "Concurrency, routing balance, communication pressure, and resilience require execution.",
        known: [],
        unknown: [
          "SLA throughput frontier",
          "expert-load distribution",
          "all-to-all communication share",
          "failure and recovery behavior",
        ],
      },
      economics: {
        status: readinessBlocked ? "blocked" : "unknown",
        evidenceClass: "unknown",
        summary: "Cost requires successful-token throughput, utilization, power, and price evidence.",
        known: [],
        unknown: [
          "cost per one million successful output tokens",
          "energy per successful token",
          "utilization-adjusted monthly cost",
        ],
      },
    },
    risks: [
      ...(staticBlocked
        ? ["Requested accelerator capacity is below the static checkpoint-residency floor."]
        : []),
      ...(runtimeCompatibility === "unknown"
        ? [`No reviewed ${runtime} compatibility result proves this exact configuration.`]
        : []),
      "Static checkpoint fit excludes KV cache, activations, routing buffers, allocator fragmentation, and host memory.",
      "No controlled workload result currently supports a performance or cost prediction.",
    ],
    validationGates: buildValidationGates(input, fit, staticStatus, runtime),
    nextAction,
    reproducibility: {
      cli: cliArguments.join(" "),
      apiPath: `/api/v1/plan?${query(apiParameters)}`,
      assumptions: [
        "Accelerator capacity uses decimal gigabytes from the versioned hardware registry.",
        "The declared reserve is applied before integer checkpoint-residency division.",
        "Node rounding is a planning convention, not proof of a supported sharding topology.",
      ],
    },
  };
}
