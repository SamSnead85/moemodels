import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalSha256Hex,
  canonicalizeJson,
  packEvidencePassport,
  runEndpointBenchmark,
  serializeEvidencePassport,
  signEvidencePassport,
  summarizeRequestMeasurements,
  verifyEvidencePassport,
} from "../dist/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(testDirectory);
const cliPath = join(packageDirectory, "dist", "cli.js");

const streamBody = [
  'data: {"choices":[{"delta":{"content":"deploy"}}]}',
  "",
  'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":1}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

function monotonicClock() {
  let value = 0;
  return () => {
    value += 5;
    return value;
  };
}

async function compatibleTrial(index) {
  const started = Date.parse("2026-08-03T12:00:00.000Z") + index * 60_000;
  let wallRead = 0;
  return runEndpointBenchmark({
    endpoint: "https://inference.example/v1/chat/completions",
    model: "acme/exact-moe",
    prompt: "stable private workload",
    maxOutputTokens: 32,
    requests: 2,
    concurrency: 1,
    warmupRequests: 0,
    artifactRepository: "acme/exact-moe",
    artifactRevision: "0123456789abcdef0123456789abcdef01234567",
    runtime: "vllm",
    runtimeVersion: "1.2.3",
    hardware: "8x H200 SXM",
    topology: "1 node; NVLink",
    now: monotonicClock(),
    wallClock: () => new Date(started + wallRead++ * 1_000),
    fetchImplementation: async () =>
      new Response(streamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
  });
}

async function threeTrials() {
  return Promise.all([compatibleTrial(0), compatibleTrial(1), compatibleTrial(2)]);
}

test("canonical JSON and its SHA-256 are stable across object insertion order", async () => {
  const left = { z: [3, { b: true, a: "x" }], a: 1, negativeZero: -0 };
  const right = { negativeZero: 0, a: 1, z: [3, { a: "x", b: true }] };

  assert.equal(
    canonicalizeJson(left),
    '{"a":1,"negativeZero":0,"z":[3,{"a":"x","b":true}]}',
  );
  assert.equal(canonicalizeJson(left), canonicalizeJson(right));
  assert.equal(await canonicalSha256Hex(left), await canonicalSha256Hex(right));
  assert.throws(() => canonicalizeJson({ invalid: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalizeJson({ invalid: "\ud800" }), /lone high surrogate/);
});

test("packing is input-order independent and three compatible trials satisfy v0.2 gates", async () => {
  const trials = await threeTrials();
  const passport = await packEvidencePassport(trials);
  const reversed = await packEvidencePassport([...trials].reverse());
  const verification = await verifyEvidencePassport(passport);

  assert.equal(passport.passportId, reversed.passportId);
  assert.equal(serializeEvidencePassport(passport), serializeEvidencePassport(reversed));
  assert.equal(passport.payload.reproducibility.complete, true);
  assert.equal(passport.payload.reproducibility.observedTrials, 3);
  assert.deepEqual(passport.payload.reproducibility.missing, []);
  assert.equal(passport.classification.comparisonEligible, false);
  assert.equal(verification.valid, true, verification.issues.join("\n"));
  assert.equal(verification.payloadDigestValid, true);
  assert.equal(verification.configurationDigestValid, true);
  assert.equal(verification.summariesValid, true);
  assert.equal(verification.compatibleTrials, true);
  assert.equal(verification.reproducibilityClaimsValid, true);
  assert.equal(verification.comparisonEligible, false);
});

test("a valid two-trial passport remains explicitly incomplete and comparison ineligible", async () => {
  const trials = await Promise.all([compatibleTrial(0), compatibleTrial(1)]);
  const passport = await packEvidencePassport(trials);
  const verification = await verifyEvidencePassport(passport);

  assert.equal(verification.valid, true, verification.issues.join("\n"));
  assert.equal(passport.payload.reproducibility.complete, false);
  assert.deepEqual(passport.payload.reproducibility.missing, ["minimum_trials"]);
  assert.equal(verification.comparisonEligible, false);
});

test("packing rejects trials with incompatible model or deployment configuration", async () => {
  const trials = await Promise.all([compatibleTrial(0), compatibleTrial(1)]);
  const incompatible = structuredClone(trials[1]);
  incompatible.run.model = "acme/another-moe";

  await assert.rejects(
    () => packEvidencePassport([trials[0], incompatible]),
    /must share an identical endpoint, model, artifact, runtime, infrastructure, and workload/,
  );
});

test("verification detects canonical payload tampering and recomputed-summary drift", async () => {
  const passport = await packEvidencePassport(await threeTrials());
  const tampered = structuredClone(passport);
  tampered.payload.trials[0].measurements[0].totalLatencyMs += 1;

  const verification = await verifyEvidencePassport(tampered);

  assert.equal(verification.valid, false);
  assert.equal(verification.schemaValid, true);
  assert.equal(verification.payloadDigestValid, false);
  assert.equal(verification.passportIdValid, false);
  assert.equal(verification.summariesValid, false);
  assert.ok(verification.issues.some((issue) => issue.includes("values do not recompute")));
  assert.ok(verification.issues.some((issue) => issue.includes("payloadSha256")));
});

test("nested malformed trial shapes fail schema validation without throwing", async () => {
  const passport = await packEvidencePassport(await threeTrials());
  const malformed = structuredClone(passport);
  delete malformed.payload.trials[0].summary;

  const verification = await verifyEvidencePassport(malformed);

  assert.equal(verification.valid, false);
  assert.equal(verification.schemaValid, false);
  assert.equal(verification.recomputedReproducibility, null);
  assert.ok(
    verification.issues.some((issue) =>
      issue.includes("$.payload.trials[0].summary"),
    ),
    verification.issues.join("\n"),
  );
});

test("material measurement gaps keep reproducibility incomplete without invalidating integrity", async (context) => {
  const cases = [
    {
      name: "missing successful-request TTFT",
      expectedDetail: /Successful-request TTFT is incomplete/,
      mutate(trial) {
        trial.measurements[0].ttftMs = null;
        trial.summary = summarizeRequestMeasurements(
          trial.measurements,
          trial.summary.wallTimeMs,
        );
      },
    },
    {
      name: "missing returned token usage and throughput",
      expectedDetail: /Returned token usage or output-token throughput is incomplete/,
      mutate(trial) {
        trial.measurements[0].promptTokens = null;
        trial.measurements[0].outputTokens = null;
        trial.summary = summarizeRequestMeasurements(
          trial.measurements,
          trial.summary.wallTimeMs,
        );
      },
    },
    {
      name: "no successful request",
      expectedDetail: /No successful request is available/,
      mutate(trial) {
        trial.measurements.forEach((measurement) => {
          measurement.status = "failed";
          measurement.httpStatus = 500;
          measurement.ttftMs = null;
          measurement.promptTokens = null;
          measurement.outputTokens = null;
          measurement.outputCharacters = 0;
          measurement.errorCode = "HTTP_500";
        });
        trial.summary = summarizeRequestMeasurements(
          trial.measurements,
          trial.summary.wallTimeMs,
        );
      },
    },
    {
      name: "material declared missing context",
      expectedDetail: /Clock source and resolution were not recorded/,
      mutate(trial) {
        trial.missingContext = [
          ...trial.missingContext,
          "Clock source and resolution were not recorded.",
        ];
      },
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const trials = await threeTrials();
      item.mutate(trials[0]);

      const passport = await packEvidencePassport(trials);
      const verification = await verifyEvidencePassport(passport);
      const measurementGate = passport.payload.reproducibility.gates.find(
        (gate) => gate.id === "request_measurements",
      );
      const recomputedMeasurementGate = verification.recomputedReproducibility?.gates.find(
        (gate) => gate.id === "request_measurements",
      );

      assert.equal(passport.payload.reproducibility.complete, false);
      assert.deepEqual(passport.payload.reproducibility.missing, ["request_measurements"]);
      assert.equal(measurementGate?.passed, false);
      assert.match(measurementGate?.detail ?? "", item.expectedDetail);
      assert.equal(recomputedMeasurementGate?.passed, false);
      assert.match(recomputedMeasurementGate?.detail ?? "", item.expectedDetail);
      assert.equal(verification.valid, true, verification.issues.join("\n"));
      assert.equal(verification.schemaValid, true);
      assert.equal(verification.reproducibilityClaimsValid, true);
      assert.equal(verification.comparisonEligible, false);
    });
  }
});

test("Ed25519 signatures verify only self-asserted authorship and never change eligibility", async () => {
  const passport = await packEvidencePassport(await threeTrials());
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const signed = await signEvidencePassport(passport, privateKeyPem);
  const verification = await verifyEvidencePassport(signed);

  assert.equal(signed.passportId, passport.passportId);
  assert.equal(signed.payloadSha256, passport.payloadSha256);
  assert.equal(signed.signatures.length, 1);
  assert.equal(verification.valid, true, verification.issues.join("\n"));
  assert.deepEqual(
    verification.signatures.map(({ status, authorshipOnly, trusted }) => ({
      status,
      authorshipOnly,
      trusted,
    })),
    [{ status: "valid_self_signed", authorshipOnly: true, trusted: false }],
  );
  assert.equal(verification.comparisonEligible, false);

  const forged = structuredClone(signed);
  const original = forged.signatures[0].signatureBase64;
  forged.signatures[0].signatureBase64 = `${original.startsWith("A") ? "B" : "A"}${original.slice(1)}`;
  const forgedVerification = await verifyEvidencePassport(forged);
  assert.equal(forgedVerification.valid, false);
  assert.equal(forgedVerification.signatures[0].status, "invalid");
});

test("browser verifier surface has no Node runtime imports", async () => {
  const browser = await import("../dist/browser.js");
  assert.equal(typeof browser.verifyEvidencePassport, "function");
  assert.equal(typeof browser.packEvidencePassport, "function");
  assert.equal(browser.runEndpointBenchmark, undefined);
  assert.equal(browser.signEvidencePassport, undefined);

  for (const emittedFile of [
    "browser.js",
    "canonical.js",
    "passport.js",
    "passport-types.js",
    "passport-verify.js",
    "summary.js",
    "types.js",
  ]) {
    const source = await readFile(join(packageDirectory, "dist", emittedFile), "utf8");
    assert.doesNotMatch(source, /from ["']node:/, `${emittedFile} imported a Node built-in`);
  }
});

test("CLI packs, verifies, signs, and refuses to overwrite evidence files", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "moemodels-passport-"));
  context.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const trials = await threeTrials();
  const trialPaths = await Promise.all(
    trials.map(async (trial, index) => {
      const path = join(temporaryDirectory, `trial-${index}.json`);
      await writeFile(path, `${JSON.stringify(trial)}\n`, "utf8");
      return path;
    }),
  );
  const passportPath = join(temporaryDirectory, "passport.json");
  const signedPath = join(temporaryDirectory, "signed.json");
  const privateKeyPath = join(temporaryDirectory, "operator.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { encoding: "utf8", mode: 0o600 },
  );

  const packed = spawnSync(
    process.execPath,
    [cliPath, "pack", ...trialPaths, "--output", passportPath, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr);
  assert.equal(JSON.parse(packed.stdout).comparisonEligible, false);

  const verified = spawnSync(process.execPath, [cliPath, "verify", passportPath, "--json"], {
    encoding: "utf8",
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).valid, true);

  const signed = spawnSync(
    process.execPath,
    [
      cliPath,
      "sign",
      passportPath,
      "--private-key",
      privateKeyPath,
      "--output",
      signedPath,
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(signed.status, 0, signed.stderr);
  assert.equal(JSON.parse(signed.stdout).signatureStatus, "self_signed_authorship_only");

  const refused = spawnSync(
    process.execPath,
    [cliPath, "pack", ...trialPaths, "--output", passportPath],
    { encoding: "utf8" },
  );
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Refusing to overwrite existing output/);
});
