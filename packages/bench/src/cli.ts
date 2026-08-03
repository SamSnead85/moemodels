#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  EVIDENCE_PASSPORT_SCHEMA_VERSION,
  EvidencePassportError,
  packEvidencePassport,
  runEndpointBenchmark,
  serializeEvidencePassport,
  signEvidencePassport,
  verifyEvidencePassport,
  type EndpointBenchmarkResult,
} from "./index.js";

const VERSION = "0.1.0";
const DEFAULT_PROMPT =
  "Explain why exact artifact identity matters when benchmarking an expert-routed language model.";

const HELP = `moemodels-bench ${VERSION}

Measure an endpoint and package compatible trials into a tamper-evident evidence passport.

Usage:
  moemodels-bench run --endpoint <url> --model <served-model> [options]
  moemodels-bench pack <trial.json...> --output <passport.json> [--json]
  moemodels-bench verify <passport.json> [--json]
  moemodels-bench sign <passport.json> --private-key <ed25519.pem>
    --output <signed-passport.json> [--json]

Run options:
  --prompt-file <path>          Read one representative prompt from a local file
  --max-output-tokens <n>       Maximum output tokens (default: 128)
  --requests <n>                Measured requests (default: 8)
  --concurrency <n>             Concurrent workers (default: 1)
  --warmup-requests <n>         Excluded warmup requests (default: 1)
  --timeout-ms <n>              Per-request timeout (default: 120000)
  --artifact-repository <id>    Declared checkpoint repository
  --artifact-revision <sha>     Declared immutable checkpoint revision
  --runtime <name>              Serving runtime name
  --runtime-version <version>   Exact serving runtime version
  --hardware <name>             Accelerator identity
  --topology <description>      Node, accelerator, and interconnect layout
  --output <path>               Write JSON without overwriting an existing file

General options:
  --json                        Emit machine-readable command status
  --help                        Show help
  --version                     Show version

Evidence passports use schema ${EVIDENCE_PASSPORT_SCHEMA_VERSION}. Packing and
signing never make a result comparison eligible. An operator signature proves
only that a key signed the canonical payload; it does not verify the declared
model, runtime, hardware, topology, or measurement truth.`;

interface RunArguments {
  endpoint?: string;
  model?: string;
  promptFile?: string;
  maxOutputTokens: number;
  requests: number;
  concurrency: number;
  warmupRequests: number;
  timeoutMs: number;
  artifactRepository?: string;
  artifactRevision?: string;
  runtime?: string;
  runtimeVersion?: string;
  hardware?: string;
  topology?: string;
  output?: string;
}

function integer(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) throw new Error(`${option} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function parseRunArguments(args: string[]): RunArguments {
  const parsed: RunArguments = {
    maxOutputTokens: 128,
    requests: 8,
    concurrency: 1,
    warmupRequests: 1,
    timeoutMs: 120_000,
  };
  const stringOptions: Record<
    string,
    keyof Pick<
      RunArguments,
      | "endpoint"
      | "model"
      | "promptFile"
      | "artifactRepository"
      | "artifactRevision"
      | "runtime"
      | "runtimeVersion"
      | "hardware"
      | "topology"
      | "output"
    >
  > = {
    "--endpoint": "endpoint",
    "--model": "model",
    "--prompt-file": "promptFile",
    "--artifact-repository": "artifactRepository",
    "--artifact-revision": "artifactRevision",
    "--runtime": "runtime",
    "--runtime-version": "runtimeVersion",
    "--hardware": "hardware",
    "--topology": "topology",
    "--output": "output",
  };
  const integerOptions: Record<
    string,
    keyof Pick<
      RunArguments,
      "maxOutputTokens" | "requests" | "concurrency" | "warmupRequests" | "timeoutMs"
    >
  > = {
    "--max-output-tokens": "maxOutputTokens",
    "--requests": "requests",
    "--concurrency": "concurrency",
    "--warmup-requests": "warmupRequests",
    "--timeout-ms": "timeoutMs",
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const stringKey = stringOptions[argument ?? ""];
    const integerKey = integerOptions[argument ?? ""];
    if (stringKey || integerKey) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      if (stringKey) parsed[stringKey] = value;
      if (integerKey) {
        parsed[integerKey] = integer(
          value,
          argument ?? "option",
          integerKey === "warmupRequests",
        );
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown run option: ${argument ?? ""}`);
  }
  return parsed;
}

async function writeNew(path: string, contents: string): Promise<string> {
  const outputPath = resolve(path);
  try {
    await writeFile(outputPath, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
    }
    throw error;
  }
  return outputPath;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path: string): Promise<unknown> {
  const inputPath = resolve(path);
  try {
    return JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read JSON from ${inputPath}: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
}

async function runCommand(args: string[]): Promise<void> {
  const parsed = parseRunArguments(args);
  if (!parsed.endpoint) throw new Error("run requires --endpoint.");
  if (!parsed.model) throw new Error("run requires --model.");
  const prompt = parsed.promptFile
    ? await readFile(resolve(parsed.promptFile), "utf8")
    : DEFAULT_PROMPT;
  const result = await runEndpointBenchmark({
    endpoint: parsed.endpoint,
    model: parsed.model,
    prompt,
    maxOutputTokens: parsed.maxOutputTokens,
    requests: parsed.requests,
    concurrency: parsed.concurrency,
    warmupRequests: parsed.warmupRequests,
    timeoutMs: parsed.timeoutMs,
    ...(process.env.MOEMODELS_BENCH_API_KEY
      ? { apiKey: process.env.MOEMODELS_BENCH_API_KEY }
      : {}),
    ...(parsed.artifactRepository ? { artifactRepository: parsed.artifactRepository } : {}),
    ...(parsed.artifactRevision ? { artifactRevision: parsed.artifactRevision } : {}),
    ...(parsed.runtime ? { runtime: parsed.runtime } : {}),
    ...(parsed.runtimeVersion ? { runtimeVersion: parsed.runtimeVersion } : {}),
    ...(parsed.hardware ? { hardware: parsed.hardware } : {}),
    ...(parsed.topology ? { topology: parsed.topology } : {}),
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (!parsed.output) {
    process.stdout.write(serialized);
    return;
  }
  const outputPath = await writeNew(parsed.output, serialized);
  process.stdout.write(
    `Wrote ${result.summary.successfulRequests}/${result.summary.attemptedRequests} measured requests to ${outputPath}\n`,
  );
}

function parsePackArguments(args: string[]): {
  trials: string[];
  output: string;
  json: boolean;
} {
  const trials: string[] = [];
  let output: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--output") {
      output = args[index + 1];
      if (!output) throw new Error("--output requires a value.");
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) throw new Error(`Unknown pack option: ${argument}`);
    if (argument) trials.push(argument);
  }
  if (trials.length === 0) throw new Error("pack requires at least one trial JSON file.");
  if (!output) throw new Error("pack requires --output.");
  return { trials, output, json };
}

async function packCommand(args: string[]): Promise<void> {
  const parsed = parsePackArguments(args);
  const trials = await Promise.all(
    parsed.trials.map(async (path) => (await readJson(path)) as EndpointBenchmarkResult),
  );
  const passport = await packEvidencePassport(trials);
  const outputPath = await writeNew(parsed.output, serializeEvidencePassport(passport));
  const status = {
    passportId: passport.passportId,
    output: outputPath,
    trials: passport.payload.trials.length,
    reproducibilityComplete: passport.payload.reproducibility.complete,
    comparisonEligible: false,
  };
  if (parsed.json) writeJson(status);
  else {
    process.stdout.write(
      `Packed ${status.trials} trial(s) as ${status.passportId}\nReproducibility complete: ${status.reproducibilityComplete ? "yes" : "no"}\nWrote ${status.output}\n`,
    );
  }
}

function parseVerifyArguments(args: string[]): { input: string; json: boolean } {
  let input: string | undefined;
  let json = false;
  for (const argument of args) {
    if (argument === "--json") json = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown verify option: ${argument}`);
    else if (input === undefined) input = argument;
    else throw new Error("verify accepts exactly one passport file.");
  }
  if (!input) throw new Error("verify requires a passport JSON file.");
  return { input, json };
}

async function verifyCommand(args: string[]): Promise<void> {
  const parsed = parseVerifyArguments(args);
  const passport = await readJson(parsed.input);
  const verification = await verifyEvidencePassport(passport);
  if (parsed.json) writeJson(verification);
  else if (verification.valid) {
    process.stdout.write(
      `Valid evidence passport.\nReproducibility complete: ${verification.recomputedReproducibility?.complete ? "yes" : "no"}\nSignatures: ${verification.signatures.length}\nComparison eligible: no\n`,
    );
  } else {
    verification.issues.forEach((issue) => process.stderr.write(`${issue}\n`));
  }
  if (!verification.valid) process.exitCode = 1;
}

function parseSignArguments(args: string[]): {
  input: string;
  privateKey: string;
  output: string;
  json: boolean;
} {
  let input: string | undefined;
  let privateKey: string | undefined;
  let output: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--private-key" || argument === "--output") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      if (argument === "--private-key") privateKey = value;
      else output = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) throw new Error(`Unknown sign option: ${argument}`);
    if (argument && input === undefined) input = argument;
    else throw new Error("sign accepts exactly one passport file.");
  }
  if (!input) throw new Error("sign requires a passport JSON file.");
  if (!privateKey) throw new Error("sign requires --private-key.");
  if (!output) throw new Error("sign requires --output.");
  return { input, privateKey, output, json };
}

async function signCommand(args: string[]): Promise<void> {
  const parsed = parseSignArguments(args);
  const [passport, privateKeyPem] = await Promise.all([
    readJson(parsed.input),
    readFile(resolve(parsed.privateKey), "utf8"),
  ]);
  const signed = await signEvidencePassport(passport, privateKeyPem);
  const outputPath = await writeNew(parsed.output, serializeEvidencePassport(signed));
  const signature = signed.signatures.at(-1);
  const status = {
    passportId: signed.passportId,
    output: outputPath,
    keyId: signature?.keyId ?? null,
    signatureStatus: "self_signed_authorship_only",
    comparisonEligible: false,
  };
  if (parsed.json) writeJson(status);
  else {
    process.stdout.write(
      `Signed ${status.passportId} with ${status.keyId}.\nAuthorship only; configuration truth is not verified.\nWrote ${status.output}\n`,
    );
  }
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
  if (command === "run") return runCommand(args);
  if (command === "pack") return packCommand(args);
  if (command === "verify") return verifyCommand(args);
  if (command === "sign") return signCommand(args);
  throw new Error(`Unknown command: ${command ?? ""}.\n\n${HELP}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`moemodels-bench: ${message}\n`);
  if (error instanceof EvidencePassportError) {
    error.issues.forEach((issue) => process.stderr.write(`${issue}\n`));
  }
  process.exitCode = 2;
});
