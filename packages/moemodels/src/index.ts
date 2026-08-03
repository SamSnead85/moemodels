#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const BENCH_COMMANDS = new Set(["run", "pack", "verify", "sign"]);

const HELP = `moemodels ${VERSION}

Plan, run, and verify evidence for an exact MoE deployment.

Usage:
  moemodels plan <model> <hardware> [options]
  moemodels run --endpoint <url> --model <served-model> [options]
  moemodels pack <trial.json...> --output <passport.json> [--json]
  moemodels verify <passport.json> [--json]
  moemodels sign <passport.json> --private-key <ed25519.pem> --output <file>

Registry and evidence commands:
  models, model, compatibility, fit, validate, evals, eval,
  validate-evals, ingest

Run "moemodels <command> --help" for command-specific options. Measurement
does not establish universal compatibility or comparison eligibility.`;

function targetFor(command: string | undefined): string {
  return BENCH_COMMANDS.has(command ?? "")
    ? import.meta.resolve("@moemodels/bench/cli")
    : import.meta.resolve("@moemodels/cli");
}

export function run(argv: readonly string[] = process.argv.slice(2)): number {
  const [command] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const child = spawnSync(
    process.execPath,
    [fileURLToPath(targetFor(command)), ...argv],
    { stdio: "inherit", env: process.env },
  );
  if (child.error) {
    process.stderr.write(`moemodels: unable to start command: ${child.error.message}\n`);
    return 1;
  }
  if (child.signal) {
    process.stderr.write(`moemodels: command terminated by ${child.signal}\n`);
    return 1;
  }
  return child.status ?? 1;
}

process.exitCode = run();
