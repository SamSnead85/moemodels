#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildDeploymentPlan,
  calculateResidencyFit,
  evaluationRegistry,
  findHardware,
  findModel,
  listReportedBenchmarkClaims,
  listEvaluationArtifactsForRun,
  listEvaluationSourcesForRun,
  parseEvaluationRegistry,
  parseRegistry,
  EvaluationValidationError,
  registry,
  RegistryValidationError,
  type Claim,
  type HardwareRecord,
  type ModelRecord,
  type ProvenanceRef,
} from "@moemodels/core";
import {
  inspectLmEvalArtifact,
  LmEvalIngestionError,
  normalizeLmEvalArtifact,
  parseNormalizedLmEvalArtifact,
  serializeNormalizedLmEvalArtifact,
} from "@moemodels/ingest";

const VERSION = "0.1.0";

const HELP = `moemodels ${VERSION}

Offline model evidence and deterministic static-residency checks.

Usage:
  moemodels models [--json]
  moemodels model <model-id|repository> [--json]
  moemodels compatibility <model-id|repository> [hardware-id] [options]
  moemodels fit <model-id|repository> <hardware-id> [options]
  moemodels plan <model-id|repository> <hardware-id> [options]
  moemodels validate [registry.json] [--json]
  moemodels evals [--model <id>] [--suite <name>] [--json]
  moemodels eval <evidence-id> [--json]
  moemodels validate-evals [registry-or-import.json] [--json]
  moemodels ingest lm-eval <results.json> --source-url <url>
    --retrieved-at <YYYY-MM-DD> [--model <id>] [--output <file>] [--json]

Options:
  --hardware <id>         Hardware alias; alternative to positional hardware
  --gpus, --devices <n>   Requested accelerator count (fit only)
  --reserve-pct <percent> Capacity reserve; up to two decimals (default: 13)
  --reserve-bps <bps>     Capacity reserve in basis points (default: 1300)
  --per-node <count>      Accelerators per topology node (default: 8)
  --devices-per-node <n>  Alias for --per-node
  --runtime <name>        Runtime evidence filter (compatibility only)
  --input-tokens <n>      Target prompt length for a validation plan
  --output-tokens <n>     Target generated length for a validation plan
  --concurrency <n>       Simultaneous requests for a validation plan
  --target-ttft-ms <n>    P95 time-to-first-token acceptance target
  --target-inter-token-ms <n>  P95 inter-token latency acceptance target
  --availability <mode>   single or ha (default: single)
  --model <id>            Exact registry model filter or expected import model
  --suite <name>          Benchmark suite substring filter
  --source-url <url>      Immutable source URL recorded by an ingestion import
  --retrieved-at <date>   Source retrieval date in YYYY-MM-DD form
  --source-id <slug>      Optional deterministic source identifier
  --title <text>          Human-readable evaluation artifact title
  --publisher <name>      Run operator or evidence publisher
  --license <expression>  License asserted for the staged raw artifact
  --output <file>         Write normalized evidence without overwriting
  --json                  Emit stable JSON
  --help                  Show command help
  --version               Show CLI version

Compatibility is evidence, not inference. A static artifact fit never changes
an unknown runtime-compatibility record into supported or unsupported.`;

interface PlanArguments {
  positionals: string[];
  json: boolean;
  devices?: number;
  devicesPerNode?: number;
  reserveBasisPoints?: number;
  runtime?: string;
  inputTokens?: number;
  outputTokens?: number;
  concurrency?: number;
  targetTtftMs?: number;
  targetInterTokenMs?: number;
  availability?: "single" | "ha";
  output?: string;
}

function parsePlanArguments(args: string[]): PlanArguments {
  const parsed: PlanArguments = { positionals: [], json: false };
  const integerOptions: Record<
    string,
    keyof Pick<
      PlanArguments,
      | "devices"
      | "devicesPerNode"
      | "inputTokens"
      | "outputTokens"
      | "concurrency"
      | "targetTtftMs"
      | "targetInterTokenMs"
    >
  > = {
    "--gpus": "devices",
    "--devices": "devices",
    "--per-node": "devicesPerNode",
    "--devices-per-node": "devicesPerNode",
    "--input-tokens": "inputTokens",
    "--output-tokens": "outputTokens",
    "--concurrency": "concurrency",
    "--target-ttft-ms": "targetTtftMs",
    "--target-inter-token-ms": "targetInterTokenMs",
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    const integerKey = integerOptions[argument ?? ""];
    if (integerKey) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      parsed[integerKey] = parsePositiveInteger(value, argument ?? "plan option");
      index += 1;
      continue;
    }
    if (argument === "--reserve-bps" || argument === "--reserve-pct") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      if (argument === "--reserve-pct") {
        parsed.reserveBasisPoints = parsePercentToBasisPoints(value);
      } else {
        if (!/^\d+$/.test(value)) {
          throw new Error("--reserve-bps must be an integer from 0 through 9999.");
        }
        const basisPoints = Number(value);
        if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 9999) {
          throw new Error("--reserve-bps must be an integer from 0 through 9999.");
        }
        parsed.reserveBasisPoints = basisPoints;
      }
      index += 1;
      continue;
    }
    if (argument === "--runtime" || argument === "--availability" || argument === "--output") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      if (argument === "--runtime") parsed.runtime = value;
      if (argument === "--output") parsed.output = value;
      if (argument === "--availability") {
        if (value !== "single" && value !== "ha") {
          throw new Error("--availability must be single or ha.");
        }
        parsed.availability = value;
      }
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) throw new Error(`Unknown plan option: ${argument}`);
    if (argument !== undefined) parsed.positionals.push(argument);
  }
  return parsed;
}

interface EvidenceArguments {
  positionals: string[];
  json: boolean;
  model?: string;
  suite?: string;
  sourceUrl?: string;
  retrievedAt?: string;
  sourceId?: string;
  title?: string;
  publisher?: string;
  output?: string;
  license?: string;
}

function parseEvidenceArguments(args: string[]): EvidenceArguments {
  const parsed: EvidenceArguments = { positionals: [], json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    const options: Record<string, keyof Omit<EvidenceArguments, "positionals" | "json">> = {
      "--model": "model",
      "--suite": "suite",
      "--source-url": "sourceUrl",
      "--retrieved-at": "retrievedAt",
      "--source-id": "sourceId",
      "--title": "title",
      "--publisher": "publisher",
      "--output": "output",
      "--license": "license",
    };
    const key = options[argument ?? ""];
    if (key) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      parsed[key] = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) throw new Error(`Unknown evidence option: ${argument}`);
    if (argument !== undefined) parsed.positionals.push(argument);
  }
  return parsed;
}

interface ParsedArguments {
  positionals: string[];
  json: boolean;
  gpus?: number;
  reserveBasisPoints?: number;
  perNode?: number;
  hardware?: string;
  runtime?: string;
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${option} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive safe integer.`);
  }
  return parsed;
}

export function parsePercentToBasisPoints(value: string): number {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("--reserve-pct must be a percent with at most two decimal places.");
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0") || "0");
  const basisPoints = whole * 100 + fraction;
  if (basisPoints < 0 || basisPoints > 9999) {
    throw new Error("--reserve-pct must be from 0 through 99.99.");
  }
  return basisPoints;
}

function parseArguments(args: string[]): ParsedArguments {
  const parsed: ParsedArguments = { positionals: [], json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (
      argument === "--gpus" ||
      argument === "--devices" ||
      argument === "--reserve-pct" ||
      argument === "--reserve-bps" ||
      argument === "--per-node" ||
      argument === "--devices-per-node" ||
      argument === "--hardware" ||
      argument === "--runtime"
    ) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      if (argument === "--gpus" || argument === "--devices") {
        parsed.gpus = parsePositiveInteger(value, argument);
      }
      if (argument === "--reserve-pct") parsed.reserveBasisPoints = parsePercentToBasisPoints(value);
      if (argument === "--reserve-bps") {
        if (!/^\d+$/.test(value)) throw new Error("--reserve-bps must be an integer from 0 through 9999.");
        const basisPoints = Number(value);
        if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 9999) {
          throw new Error("--reserve-bps must be an integer from 0 through 9999.");
        }
        parsed.reserveBasisPoints = basisPoints;
      }
      if (argument === "--per-node" || argument === "--devices-per-node") {
        parsed.perNode = parsePositiveInteger(value, argument);
      }
      if (argument === "--hardware") parsed.hardware = value;
      if (argument === "--runtime") parsed.runtime = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    if (argument !== undefined) parsed.positionals.push(argument);
  }
  return parsed;
}

function rejectFitOptions(parsed: ParsedArguments, command: string): void {
  if (
    parsed.gpus !== undefined ||
    parsed.reserveBasisPoints !== undefined ||
    parsed.perNode !== undefined ||
    parsed.hardware !== undefined ||
    parsed.runtime !== undefined
  ) {
    throw new Error(`${command} does not accept fit options.`);
  }
}

function sourceFor(sourceId: string) {
  return registry.sources.find((source) => source.id === sourceId);
}

function provenanceJson(refs: readonly ProvenanceRef[]) {
  return refs.map((ref) => {
    const source = sourceFor(ref.sourceId);
    return {
      sourceId: ref.sourceId,
      title: source?.title ?? null,
      url: source?.url ?? null,
      retrievedAt: source?.retrievedAt ?? null,
      locator: ref.locator ?? source?.locator ?? null,
    };
  });
}

function claimJson<T>(claim: Claim<T>) {
  return claim.status === "known"
    ? { status: "known", value: claim.value, provenance: provenanceJson(claim.provenance) }
    : {
        status: "unknown",
        value: null,
        reason: claim.reason,
        provenance: provenanceJson(claim.provenance),
      };
}

function modelJson(model: ModelRecord) {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    artifact: {
      ...model.artifact,
      provenance: provenanceJson(model.artifact.provenance),
    },
    claims: Object.fromEntries(
      Object.entries(model.claims).map(([key, claim]) => [key, claimJson(claim)]),
    ),
    provenance: provenanceJson(model.provenance),
  };
}

function claimText(claim: Claim<number | string>): string {
  if (claim.status === "unknown") return `unknown — ${claim.reason}`;
  if (typeof claim.value === "number") return new Intl.NumberFormat("en-US").format(claim.value);
  return claim.value;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join("  ").trimEnd();
  process.stdout.write(`${line(headers)}\n${line(widths.map((width) => "-".repeat(width)))}\n`);
  rows.forEach((row) => process.stdout.write(`${line(row)}\n`));
}

function requireModel(query: string | undefined): ModelRecord {
  if (!query) throw new Error("A model id, name, or canonical repository is required.");
  const model = findModel(query);
  if (!model) throw new Error(`Unknown model: ${query}`);
  return model;
}

function requireHardware(query: string | undefined): HardwareRecord {
  if (!query) throw new Error("A hardware id or alias is required.");
  const hardware = findHardware(query);
  if (!hardware) throw new Error(`Unknown hardware: ${query}`);
  return hardware;
}

function fitOptions(parsed: ParsedArguments) {
  return {
    ...(parsed.reserveBasisPoints === undefined
      ? {}
      : { reserveBasisPoints: parsed.reserveBasisPoints }),
    ...(parsed.perNode === undefined ? {} : { acceleratorsPerNode: parsed.perNode }),
    ...(parsed.gpus === undefined ? {} : { requestedAccelerators: parsed.gpus }),
  };
}

function compatibilityFor(model: ModelRecord, hardware: HardwareRecord, runtime?: string) {
  return registry.compatibility.find(
    (record) =>
      record.modelId === model.id &&
      record.hardwareId === hardware.id &&
      (runtime === undefined || record.framework.toLowerCase() === runtime.toLowerCase()),
  );
}

function compatibilityJson(model: ModelRecord, hardware: HardwareRecord, parsed: ParsedArguments) {
  const evidence = compatibilityFor(model, hardware, parsed.runtime);
  const residency = calculateResidencyFit(model, hardware, fitOptions(parsed));
  return {
    model: { id: model.id, name: model.name, repository: model.artifact.repository },
    hardware: { id: hardware.id, name: hardware.name },
    runtimeCompatibility: evidence
      ? {
          status: evidence.status,
          evidenceLevel: evidence.evidenceLevel,
          framework: evidence.framework,
          reason: evidence.reason,
          provenance: provenanceJson(evidence.provenance),
        }
      : {
          status: "unknown",
          evidenceLevel: "unknown",
          framework: parsed.runtime ?? "unspecified",
          reason: parsed.runtime
            ? `No ${parsed.runtime} compatibility evidence record exists; absence is not evidence of unsupported status.`
            : "No compatibility evidence record exists; absence is not evidence of unsupported status.",
          provenance: [],
        },
    staticResidency: residency,
  };
}

async function modelsCommand(parsed: ParsedArguments): Promise<void> {
  rejectFitOptions(parsed, "models");
  if (parsed.positionals.length > 0) throw new Error("models does not accept positional arguments.");
  if (parsed.json) {
    writeJson({ registryVersion: registry.registryVersion, models: registry.models.map(modelJson) });
    return;
  }
  writeTable(
    ["ID", "PROVIDER", "TOTAL PARAMS", "ACTIVE PARAMS", "ARTIFACT BYTES"],
    registry.models.map((model) => [
      model.id,
      model.provider,
      claimText(model.claims.totalParameters),
      claimText(model.claims.activeParameters),
      claimText(model.claims.artifactTensorBytes),
    ]),
  );
}

async function modelCommand(parsed: ParsedArguments): Promise<void> {
  rejectFitOptions(parsed, "model");
  if (parsed.positionals.length !== 1) throw new Error("Usage: moemodels model <model-id|repository>");
  const model = requireModel(parsed.positionals[0]);
  if (parsed.json) {
    writeJson(modelJson(model));
    return;
  }
  process.stdout.write(`${model.name} (${model.id})\n`);
  process.stdout.write(`Provider: ${model.provider}\n`);
  process.stdout.write(`Artifact: ${model.artifact.repository}@${model.artifact.revision}\n`);
  process.stdout.write(`Manifest: ${model.artifact.manifestUrl}\n`);
  for (const [key, claim] of Object.entries(model.claims)) {
    process.stdout.write(`${key}: ${claimText(claim)}\n`);
  }
}

async function compatibilityCommand(parsed: ParsedArguments): Promise<void> {
  if (parsed.gpus !== undefined) throw new Error("compatibility does not accept --gpus; use fit instead.");
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
    throw new Error("Usage: moemodels compatibility <model-id|repository> [hardware-id]");
  }
  const model = requireModel(parsed.positionals[0]);
  if (parsed.hardware && parsed.positionals[1]) {
    throw new Error("Specify hardware either positionally or with --hardware, not both.");
  }
  const hardwareQuery = parsed.hardware ?? parsed.positionals[1];
  const hardware = hardwareQuery ? [requireHardware(hardwareQuery)] : registry.hardware;
  const results = hardware.map((item) => compatibilityJson(model, item, parsed));
  if (parsed.json) {
    writeJson({ registryVersion: registry.registryVersion, results });
    return;
  }
  writeTable(
    ["HARDWARE", "RUNTIME", "EVIDENCE", "STATIC MIN", "TOPOLOGY"],
    results.map((result) => [
      result.hardware.id,
      result.runtimeCompatibility.status,
      result.runtimeCompatibility.evidenceLevel,
      result.staticResidency.status === "known"
        ? String(result.staticResidency.minimumAccelerators)
        : "unknown",
      result.staticResidency.status === "known"
        ? String(result.staticResidency.topologyRoundedAccelerators)
        : "unknown",
    ]),
  );
  process.stdout.write("\nStatic fit does not assert runtime compatibility; unknown does not mean unsupported.\n");
}

async function fitCommand(parsed: ParsedArguments): Promise<void> {
  if (parsed.runtime !== undefined) throw new Error("fit does not accept --runtime; use compatibility instead.");
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
    throw new Error("Usage: moemodels fit <model-id|repository> <hardware-id> [options]");
  }
  if (parsed.hardware && parsed.positionals[1]) {
    throw new Error("Specify hardware either positionally or with --hardware, not both.");
  }
  const model = requireModel(parsed.positionals[0]);
  const hardware = requireHardware(parsed.hardware ?? parsed.positionals[1]);
  const result = compatibilityJson(model, hardware, parsed);
  if (parsed.json) {
    writeJson(result);
    return;
  }
  process.stdout.write(`${model.name} → ${hardware.name}\n`);
  process.stdout.write(`Runtime compatibility: ${result.runtimeCompatibility.status} (${result.runtimeCompatibility.evidenceLevel})\n`);
  if (result.staticResidency.status === "unknown") {
    process.stdout.write(`Static residency: unknown — ${result.staticResidency.reason}\n`);
    return;
  }
  process.stdout.write(`Static minimum: ${result.staticResidency.minimumAccelerators} accelerator(s)\n`);
  process.stdout.write(`Topology-rounded: ${result.staticResidency.topologyRoundedAccelerators} accelerator(s)\n`);
  process.stdout.write(`Reserve: ${result.staticResidency.reserveBasisPoints} basis points\n`);
  if (result.staticResidency.requestedAccelerators !== null) {
    process.stdout.write(
      `Requested static fit: ${result.staticResidency.fitsRequestedAccelerators ? "pass" : "fail"}\n`,
    );
  }
  process.stdout.write("Static checkpoint tensors only; runtime allocations and framework support are not modeled.\n");
}

async function planCommand(args: string[]): Promise<void> {
  const parsed = parsePlanArguments(args);
  if (parsed.positionals.length !== 2) {
    throw new Error("Usage: moemodels plan <model-id|repository> <hardware-id> [options]");
  }
  const model = requireModel(parsed.positionals[0]);
  const hardware = requireHardware(parsed.positionals[1]);
  const plan = buildDeploymentPlan({
    model,
    hardware,
    compatibility: registry.compatibility,
    requestedAccelerators: parsed.devices ?? 8,
    acceleratorsPerNode:
      parsed.devicesPerNode ?? registry.methodology.defaultAcceleratorsPerNode,
    reserveBasisPoints:
      parsed.reserveBasisPoints ?? registry.methodology.defaultReserveBasisPoints,
    runtime: parsed.runtime ?? "unspecified",
    workload: {
      inputTokens: parsed.inputTokens ?? 4096,
      outputTokens: parsed.outputTokens ?? 1024,
      concurrency: parsed.concurrency ?? 1,
      targetTtftMs: parsed.targetTtftMs ?? 1000,
      targetInterTokenMs: parsed.targetInterTokenMs ?? 50,
      availability: parsed.availability ?? "single",
    },
  });
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;

  if (parsed.output) {
    const outputPath = resolve(parsed.output);
    try {
      await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
      }
      throw error;
    }
    if (!parsed.json) {
      process.stdout.write(
        `Wrote deployment validation plan ${plan.scenarioKey} to ${outputPath}\n`,
      );
      return;
    }
  }

  if (parsed.json) {
    process.stdout.write(serialized);
    return;
  }

  process.stdout.write(`${plan.artifact.modelName} → ${plan.target.hardwareName}\n`);
  process.stdout.write(`Plan: ${plan.scenarioKey}\n`);
  process.stdout.write(`Readiness: ${plan.readiness.status}\n`);
  process.stdout.write(`Static residency: ${plan.readiness.staticResidency}\n`);
  process.stdout.write(`Runtime compatibility: ${plan.readiness.runtimeCompatibility}\n`);
  process.stdout.write(`Next action: ${plan.nextAction.summary}\n\n`);
  writeTable(
    ["#", "GATE", "STATUS", "OBJECTIVE"],
    plan.validationGates.map((gate) => [
      String(gate.order),
      gate.title,
      gate.status,
      gate.objective,
    ]),
  );
  process.stdout.write(
    "\nCalculated static evidence only. Execute the required gates before deployment or procurement.\n",
  );
}

async function validateCommand(parsed: ParsedArguments): Promise<void> {
  if (
    parsed.gpus !== undefined ||
    parsed.reserveBasisPoints !== undefined ||
    parsed.perNode !== undefined ||
    parsed.hardware !== undefined ||
    parsed.runtime !== undefined
  ) {
    throw new Error("validate does not accept fit options.");
  }
  if (parsed.positionals.length > 1) throw new Error("Usage: moemodels validate [registry.json]");
  let candidate: unknown = registry;
  let target = "@moemodels/registry-v1";
  if (parsed.positionals[0]) {
    target = resolve(parsed.positionals[0]);
    candidate = JSON.parse(await readFile(target, "utf8")) as unknown;
  }
  try {
    const validated = parseRegistry(candidate);
    const result = {
      valid: true,
      target,
      registryVersion: validated.registryVersion,
      sources: validated.sources.length,
      models: validated.models.length,
      hardware: validated.hardware.length,
      compatibilityRecords: validated.compatibility.length,
    };
    if (parsed.json) writeJson(result);
    else process.stdout.write(`Valid registry ${validated.registryVersion}: ${validated.models.length} models, ${validated.hardware.length} hardware records, ${validated.compatibility.length} compatibility records.\n`);
  } catch (error) {
    if (error instanceof RegistryValidationError) {
      if (parsed.json) writeJson({ valid: false, target, issues: error.issues });
      else error.issues.forEach((issue) => process.stderr.write(`${issue}\n`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function evalsCommand(args: string[]): Promise<void> {
  const parsed = parseEvidenceArguments(args);
  if (
    parsed.positionals.length > 0 ||
    parsed.sourceUrl ||
    parsed.retrievedAt ||
    parsed.sourceId ||
    parsed.title ||
    parsed.publisher ||
    parsed.output ||
    parsed.license
  ) {
    throw new Error("Usage: moemodels evals [--model <id>] [--suite <name>] [--json]");
  }
  const normalizedSuite = parsed.suite?.trim().toLowerCase();
  const claims = listReportedBenchmarkClaims(parsed.model).filter(
    (claim) =>
      normalizedSuite === undefined ||
      claim.benchmark.suite.toLowerCase().includes(normalizedSuite),
  );
  const runs = evaluationRegistry.runs.filter(
    (run) =>
      (parsed.model === undefined || run.modelId === parsed.model) &&
      (normalizedSuite === undefined ||
        run.benchmark.suite.toLowerCase().includes(normalizedSuite)),
  );
  if (parsed.json) {
    writeJson({
      evaluationSchemaVersion: evaluationRegistry.schemaVersion,
      reportedClaims: claims,
      normalizedRuns: runs,
    });
    return;
  }
  writeTable(
    ["MODEL", "SUITE", "METRIC", "VALUE", "ARTIFACT LINK"],
    claims.map((claim) => [
      claim.modelId,
      claim.benchmark.suite,
      claim.metric.name,
      String(claim.metric.value),
      claim.artifactAssociation === "artifact_snapshot_associated" ? "pinned-card" : "model-name-only",
    ]),
  );
  process.stdout.write(
    `\n${claims.length} owner-reported claim(s); ${runs.length} normalized run(s). Owner-reported values are not comparison eligible.\n`,
  );
}

async function evalCommand(args: string[]): Promise<void> {
  const parsed = parseEvidenceArguments(args);
  if (
    parsed.positionals.length !== 1 ||
    parsed.model ||
    parsed.suite ||
    parsed.sourceUrl ||
    parsed.retrievedAt ||
    parsed.sourceId ||
    parsed.title ||
    parsed.publisher ||
    parsed.output ||
    parsed.license
  ) {
    throw new Error("Usage: moemodels eval <evidence-id> [--json]");
  }
  const id = parsed.positionals[0] as string;
  const claim = evaluationRegistry.reportedClaims.find((item) => item.id === id);
  const run = evaluationRegistry.runs.find((item) => item.id === id);
  if (!claim && !run) throw new Error(`Unknown evaluation evidence record: ${id}`);
  if (parsed.json) {
    writeJson({
      evaluationSchemaVersion: evaluationRegistry.schemaVersion,
      kind: claim ? "owner_reported_claim" : "normalized_run",
      record: claim ?? run,
      sources: claim
        ? evaluationRegistry.sources.filter((source) =>
            claim.sourceRefs.some((reference) => reference.sourceId === source.id),
          )
        : listEvaluationSourcesForRun(id),
      rawArtifacts: run ? listEvaluationArtifactsForRun(id) : [],
    });
    return;
  }
  if (claim) {
    process.stdout.write(`${claim.modelName} — ${claim.benchmark.suite}\n`);
    process.stdout.write(`Metric: ${claim.metric.name} = ${claim.metric.value} ${claim.metric.unit}\n`);
    process.stdout.write(`Artifact association: ${claim.artifactAssociation}\n`);
    process.stdout.write(`Comparison eligible: no\n`);
    process.stdout.write(`Missing context: ${claim.missingContext.join("; ")}\n`);
    return;
  }
  process.stdout.write(`${run?.id}\n`);
  process.stdout.write(`Model: ${run?.modelId}\n`);
  process.stdout.write(`Suite: ${run?.benchmark.suite}\n`);
  process.stdout.write(`Comparison eligible: ${run?.comparisonEligible ? "yes" : "no"}\n`);
}

async function validateEvaluationsCommand(args: string[]): Promise<void> {
  const parsed = parseEvidenceArguments(args);
  if (
    parsed.positionals.length > 1 ||
    parsed.model ||
    parsed.suite ||
    parsed.sourceUrl ||
    parsed.retrievedAt ||
    parsed.sourceId ||
    parsed.title ||
    parsed.publisher ||
    parsed.output ||
    parsed.license
  ) {
    throw new Error("Usage: moemodels validate-evals [registry-or-import.json] [--json]");
  }
  let candidate: unknown = evaluationRegistry;
  let target = "@moemodels/evaluations-v1";
  if (parsed.positionals[0]) {
    target = resolve(parsed.positionals[0]);
    candidate = JSON.parse(await readFile(target, "utf8")) as unknown;
  }
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "kind" in candidate &&
    (candidate as { kind?: unknown }).kind === "lm_eval_import"
  ) {
    try {
      const validated = parseNormalizedLmEvalArtifact(candidate);
      const result = {
        valid: true,
        target,
        kind: validated.kind,
        importSchemaVersion: validated.schemaVersion,
        runId: validated.run.id,
        publicationStatus: validated.run.publicationStatus,
        eligibility: validated.run.eligibility,
      };
      if (parsed.json) writeJson(result);
      else {
        process.stdout.write(
          `Valid lm-eval staging envelope ${validated.schemaVersion}: ${validated.run.id} (${validated.run.publicationStatus}).\n`,
        );
      }
    } catch (error) {
      if (error instanceof LmEvalIngestionError) {
        if (parsed.json) {
          writeJson({ valid: false, target, kind: "lm_eval_import", issues: [error.message] });
        } else {
          process.stderr.write(`${error.message}\n`);
        }
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }
  try {
    const validated = parseEvaluationRegistry(candidate, registry);
    const result = {
      valid: true,
      target,
      evaluationSchemaVersion: validated.schemaVersion,
      sources: validated.sources.length,
      reportedClaims: validated.reportedClaims.length,
      normalizedRuns: validated.runs.length,
    };
    if (parsed.json) writeJson(result);
    else process.stdout.write(
      `Valid evaluation registry ${validated.schemaVersion}: ${validated.reportedClaims.length} owner-reported claims, ${validated.runs.length} normalized runs.\n`,
    );
  } catch (error) {
    if (error instanceof EvaluationValidationError) {
      if (parsed.json) writeJson({ valid: false, target, issues: error.issues });
      else error.issues.forEach((issue) => process.stderr.write(`${issue}\n`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function ingestCommand(args: string[]): Promise<void> {
  const parsed = parseEvidenceArguments(args);
  if (parsed.positionals[0] !== "lm-eval" || parsed.positionals.length !== 2) {
    throw new Error(
      "Usage: moemodels ingest lm-eval <results.json> --source-url <url> --retrieved-at <YYYY-MM-DD> [options]",
    );
  }
  if (parsed.suite) throw new Error("ingest does not accept --suite.");
  if (!parsed.sourceUrl) throw new Error("ingest requires --source-url.");
  if (!parsed.retrievedAt) throw new Error("ingest requires --retrieved-at.");
  const inputPath = resolve(parsed.positionals[1] as string);
  const bytes = new Uint8Array(await readFile(inputPath));
  const inspection = inspectLmEvalArtifact(bytes);
  const normalized = normalizeLmEvalArtifact(bytes, {
    sourceId: parsed.sourceId ?? `lm-eval-${inspection.sha256.slice(0, 16)}`,
    title: parsed.title ?? `lm-eval result ${inspection.sha256.slice(0, 12)}`,
    publisher: parsed.publisher ?? "Unspecified run operator",
    url: parsed.sourceUrl,
    retrievedAt: parsed.retrievedAt,
    ...(parsed.model === undefined ? {} : { expectedModelId: parsed.model }),
    ...(parsed.license === undefined ? {} : { license: parsed.license }),
  });
  const serialized = serializeNormalizedLmEvalArtifact(normalized);
  if (parsed.output) {
    const outputPath = resolve(parsed.output);
    try {
      await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
      }
      throw error;
    }
    if (!parsed.json) {
      process.stdout.write(
        `Normalized ${normalized.run.tasks.length} task(s) to ${outputPath}\nRun: ${normalized.run.id}\nEligibility: ${normalized.run.eligibility.status}\n`,
      );
      return;
    }
  }
  process.stdout.write(serialized);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const command = args.shift();
  if (command === "evals") return evalsCommand(args);
  if (command === "eval") return evalCommand(args);
  if (command === "validate-evals") return validateEvaluationsCommand(args);
  if (command === "ingest") return ingestCommand(args);
  if (command === "plan") return planCommand(args);
  const parsed = parseArguments(args);
  if (command === "models") return modelsCommand(parsed);
  if (command === "model") return modelCommand(parsed);
  if (command === "compatibility") return compatibilityCommand(parsed);
  if (command === "fit") return fitCommand(parsed);
  if (command === "validate") return validateCommand(parsed);
  throw new Error(`Unknown command: ${command ?? ""}\n\n${HELP}`);
}

main().catch((error: unknown) => {
  const message =
    error instanceof LmEvalIngestionError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(`moemodels: ${message}\n`);
  process.exitCode = 2;
});
