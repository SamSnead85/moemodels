#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  verifyEvidencePassport,
  type DeployBenchEvidencePassport,
  type EndpointBenchmarkResult,
} from "@moemodels/bench/browser";

import {
  DeploymentPolicyError,
  POLICY_IDENTITY_CHANGE_PATHS,
  comparePassportConfigurations,
  evaluateDeploymentPolicy,
  policyReceiptMarkdown,
  starterDeploymentPolicy,
  validateDeploymentPolicy,
  type PolicyIdentityChangePath,
} from "./index.js";

const VERSION = "0.1.0";

const HELP = `moemodels-policy ${VERSION}

Turn verified DeployBench Evidence Passports into an explicit deployment
review decision: pass, fail, or inconclusive.

Usage:
  moemodels-policy init [--output policy.json]
  moemodels-policy check <candidate-passport.json> --policy <policy.json>
    [--baseline <passport.json>] [--summary <path>] [--json]
  moemodels-policy compare <baseline-passport.json> <candidate-passport.json>
    [--allow <identity-path>]... [--json]

Commands:
  init      Write a conservative starter policy document
  check     Evaluate a policy against a candidate (and optional baseline)
  compare   Report identity changes and workload compatibility between two
            verified Passports without issuing a verdict

Exit codes for check:
  0  pass          every required check passed with complete evidence
  1  fail          a required evidence check or rule failed
  2  usage error   invalid input, unreadable file, or invalid policy
  3  inconclusive  a metric, baseline, or comparison was unavailable

check writes a Markdown receipt to --summary, or appends it to the file named
by GITHUB_STEP_SUMMARY when that variable is set. A pass verdict applies only
to this policy's declared checks; it is not MOEModels admission, comparison
eligibility, or deployment certification.`;

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

async function initCommand(args: string[]): Promise<void> {
  let output = "policy.json";
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--output") {
      const value = args[index + 1];
      if (!value) throw new Error("--output requires a value.");
      output = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown init option: ${argument ?? ""}`);
  }
  const policy = starterDeploymentPolicy();
  const outputPath = await writeNew(output, `${JSON.stringify(policy, null, 2)}\n`);
  if (json) writeJson({ output: outputPath, name: policy.name });
  else {
    process.stdout.write(
      `Wrote starter policy "${policy.name}" to ${outputPath}\nEdit the thresholds and allowed change surface before relying on it.\n`,
    );
  }
}

interface CheckArguments {
  candidate?: string;
  policy?: string;
  baseline?: string;
  summary?: string;
  json: boolean;
}

function parseCheckArguments(args: string[]): CheckArguments {
  const parsed: CheckArguments = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (argument === "--policy" || argument === "--baseline" || argument === "--summary") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      if (argument === "--policy") parsed.policy = value;
      else if (argument === "--baseline") parsed.baseline = value;
      else parsed.summary = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) throw new Error(`Unknown check option: ${argument}`);
    if (argument && parsed.candidate === undefined) {
      parsed.candidate = argument;
      continue;
    }
    throw new Error("check accepts exactly one candidate passport file.");
  }
  if (!parsed.candidate) throw new Error("check requires a candidate passport JSON file.");
  if (!parsed.policy) throw new Error("check requires --policy.");
  return parsed;
}

async function checkCommand(args: string[]): Promise<void> {
  const parsed = parseCheckArguments(args);
  const [policy, candidate, baseline] = await Promise.all([
    readJson(parsed.policy as string),
    readJson(parsed.candidate as string),
    parsed.baseline ? readJson(parsed.baseline) : Promise.resolve(undefined),
  ]);

  const evaluation = await evaluateDeploymentPolicy({
    policy,
    candidate,
    ...(baseline === undefined ? {} : { baseline }),
    evaluatedAt: new Date(),
  });

  const receipt = policyReceiptMarkdown(evaluation);
  const summaryPath = parsed.summary ?? process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(resolve(summaryPath), receipt, "utf8");
  }

  if (parsed.json) writeJson(evaluation);
  else {
    process.stdout.write(receipt);
  }
  if (evaluation.verdict === "fail") process.exitCode = 1;
  else if (evaluation.verdict === "inconclusive") process.exitCode = 3;
}

interface CompareArguments {
  baseline?: string;
  candidate?: string;
  allow: string[];
  json: boolean;
}

function parseCompareArguments(args: string[]): CompareArguments {
  const parsed: CompareArguments = { allow: [], json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (argument === "--allow") {
      const value = args[index + 1];
      if (!value) throw new Error("--allow requires an identity path.");
      parsed.allow.push(value);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) throw new Error(`Unknown compare option: ${argument}`);
    if (argument && parsed.baseline === undefined) parsed.baseline = argument;
    else if (argument && parsed.candidate === undefined) parsed.candidate = argument;
    else throw new Error("compare accepts exactly two passport files.");
  }
  if (!parsed.baseline || !parsed.candidate) {
    throw new Error("compare requires a baseline and a candidate passport JSON file.");
  }
  return parsed;
}

async function compareCommand(args: string[]): Promise<void> {
  const parsed = parseCompareArguments(args);
  const identityPaths = new Set<string>(POLICY_IDENTITY_CHANGE_PATHS);
  for (const path of parsed.allow) {
    if (!identityPaths.has(path)) {
      throw new Error(
        `--allow ${path}: unknown identity path. Valid paths: ${POLICY_IDENTITY_CHANGE_PATHS.join(", ")}`,
      );
    }
  }
  const [baseline, candidate] = await Promise.all([
    readJson(parsed.baseline as string),
    readJson(parsed.candidate as string),
  ]);
  const [baselineVerification, candidateVerification] = await Promise.all([
    verifyEvidencePassport(baseline),
    verifyEvidencePassport(candidate),
  ]);
  if (!baselineVerification.valid || !candidateVerification.valid) {
    const issues = [
      ...(baselineVerification.valid
        ? []
        : baselineVerification.issues.map((issue) => `baseline: ${issue}`)),
      ...(candidateVerification.valid
        ? []
        : candidateVerification.issues.map((issue) => `candidate: ${issue}`)),
    ];
    throw new DeploymentPolicyError(
      "Both passports must verify before comparison.",
      issues.slice(0, 12),
    );
  }
  const baselineTrial = (baseline as DeployBenchEvidencePassport).payload
    .trials[0] as EndpointBenchmarkResult;
  const candidateTrial = (candidate as DeployBenchEvidencePassport).payload
    .trials[0] as EndpointBenchmarkResult;
  const report = comparePassportConfigurations(
    baselineTrial,
    candidateTrial,
    parsed.allow as PolicyIdentityChangePath[],
  );
  if (parsed.json) writeJson(report);
  else {
    process.stdout.write(`${report.detail}\n`);
    for (const change of report.identityChanges) {
      process.stdout.write(
        `${change.allowed ? "allowed " : "unlisted"}  ${change.path}: ${change.baseline ?? "unknown"} -> ${change.candidate ?? "unknown"}\n`,
      );
    }
  }
  if (!report.compatible) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Accept an optional leading "policy" token so the public `moemodels`
  // launcher can forward `moemodels policy check …` verbatim.
  if (args[0] === "policy") args.shift();
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args[0] === "validate-policy") {
    const path = args[1];
    if (!path) throw new Error("validate-policy requires a policy JSON file.");
    const result = validateDeploymentPolicy(await readJson(path));
    writeJson(result);
    if (!result.valid) process.exitCode = 1;
    return;
  }
  const command = args.shift();
  if (command === "init") return initCommand(args);
  if (command === "check") return checkCommand(args);
  if (command === "compare") return compareCommand(args);
  throw new Error(`Unknown command: ${command ?? ""}.\n\n${HELP}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`moemodels-policy: ${message}\n`);
  if (error instanceof DeploymentPolicyError) {
    error.issues.forEach((issue) => process.stderr.write(`${issue}\n`));
  }
  process.exitCode = 2;
});
