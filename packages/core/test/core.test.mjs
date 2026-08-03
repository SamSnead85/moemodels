import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateResidencyFit,
  calculateIntegerResidency,
  findHardware,
  findModel,
  registry,
  validateRegistry,
} from "../dist/index.js";

function model(id) {
  const value = findModel(id);
  assert.ok(value, `expected model ${id}`);
  return value;
}

function hardware(id) {
  const value = findHardware(id);
  assert.ok(value, `expected hardware ${id}`);
  return value;
}

test("canonical v1 registry validates with complete provenance", () => {
  const result = validateRegistry(structuredClone(registry));
  assert.equal(result.valid, true);
  assert.equal(registry.models.length, 5);
  assert.equal(registry.hardware.length, 4);
  assert.equal(registry.compatibility.length, 20);
  assert.ok(registry.sources.every((source) => source.retrievedAt === "2026-08-02"));
});

test("unknown claims stay first-class and do not become zeroes", () => {
  assert.deepEqual(model("glm-5-2").claims.activeParameters.status, "unknown");
  assert.deepEqual(model("kimi-k3").claims.license.status, "unknown");
  assert.ok(
    registry.compatibility.every(
      (record) => record.status === "unknown" && record.evidenceLevel === "unknown",
    ),
  );
});

test("repository ids and canonical hardware aliases resolve offline", () => {
  assert.equal(findModel("moonshotai/kimi-k3")?.id, "kimi-k3");
  assert.equal(findHardware("nvidia/h200-sxm-141gb")?.id, "h200");
  assert.equal(findHardware("nvidia/rtx-6000-ada-48gb")?.id, "rtx6000");
});

test("13 percent reserve produces pinned artifact residency acceptance values", () => {
  const kimi = calculateResidencyFit(model("kimi-k3"), hardware("h200"));
  assert.equal(kimi.status, "known");
  assert.equal(kimi.minimumAccelerators, 13);
  assert.equal(kimi.minimumNodes, 2);
  assert.equal(kimi.topologyRoundedAccelerators, 16);

  const deepseek = calculateResidencyFit(model("deepseek-v4-pro"), hardware("h200"));
  assert.equal(deepseek.status, "known");
  assert.equal(deepseek.minimumAccelerators, 8);
  assert.equal(deepseek.fitsRequestedAccelerators, null);

  const glm = calculateResidencyFit(model("glm-5-2"), hardware("h200"));
  assert.equal(glm.status, "known");
  assert.equal(glm.minimumAccelerators, 13);

  const gemmaH100 = calculateResidencyFit(model("gemma-4-26b-a4b-it"), hardware("h100"), {
    requestedAccelerators: 1,
  });
  assert.equal(gemmaH100.status, "known");
  assert.equal(gemmaH100.minimumAccelerators, 1);
  assert.equal(gemmaH100.fitsRequestedAccelerators, true);

  const gemmaRtxOne = calculateResidencyFit(model("gemma-4-26b-a4b-it"), hardware("rtx6000"), {
    requestedAccelerators: 1,
  });
  assert.equal(gemmaRtxOne.status, "known");
  assert.equal(gemmaRtxOne.minimumAccelerators, 2);
  assert.equal(gemmaRtxOne.fitsRequestedAccelerators, false);

  const gemmaRtxTwo = calculateResidencyFit(model("gemma-4-26b-a4b-it"), hardware("rtx6000"), {
    requestedAccelerators: 2,
  });
  assert.equal(gemmaRtxTwo.status, "known");
  assert.equal(gemmaRtxTwo.fitsRequestedAccelerators, true);
});

test("integer engine handles equality boundaries and rejects invalid inputs", () => {
  const equality = calculateIntegerResidency({
    artifactTensorBytes: 80_000_000_000n,
    memoryGigabytes: 80n,
    reserveBasisPoints: 0,
    acceleratorsPerNode: 8,
    requestedAccelerators: 1,
  });
  assert.equal(equality.minimumAccelerators, 1);
  assert.equal(equality.minimumNodes, 1);
  assert.equal(equality.fitsRequestedAccelerators, true);
  assert.throws(
    () => calculateIntegerResidency({ artifactTensorBytes: 1n, memoryGigabytes: 1n, requestedAccelerators: 0 }),
    /positive safe integer/,
  );
  assert.throws(
    () => calculateIntegerResidency({ artifactTensorBytes: 1n, memoryGigabytes: 1n, reserveBasisPoints: 10_000 }),
    /0 through 9999/,
  );
});

test("validator rejects dangling provenance and unsupported claims without evidence", () => {
  const dangling = structuredClone(registry);
  dangling.models[0].claims.contextTokens.provenance[0].sourceId = "missing-source";
  const danglingResult = validateRegistry(dangling);
  assert.equal(danglingResult.valid, false);
  assert.ok(danglingResult.issues.some((issue) => issue.includes('unknown source "missing-source"')));

  const unsupported = structuredClone(registry);
  unsupported.compatibility[0].status = "unsupported";
  const unsupportedResult = validateRegistry(unsupported);
  assert.equal(unsupportedResult.valid, false);
  assert.ok(unsupportedResult.issues.some((issue) => issue.includes("requires unsupported evidence")));
});

test("validator rejects unversioned artifact URLs and unexpected properties", () => {
  const candidate = structuredClone(registry);
  candidate.models[0].artifact.manifestUrl =
    "https://huggingface.co/moonshotai/Kimi-K3/blob/main/model.safetensors.index.json";
  candidate.models[0].claims.madeUpThroughput = {
    status: "known",
    value: 999,
    provenance: [{ sourceId: "kimi-k3-github" }],
  };
  const result = validateRegistry(candidate);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes("immutable URL")));
  assert.ok(result.issues.some((issue) => issue.includes("madeUpThroughput: unexpected property")));
});
