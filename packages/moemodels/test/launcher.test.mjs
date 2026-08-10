import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = join(packageDirectory, "dist", "index.js");

function launch(args) {
  return spawnSync(process.execPath, [binary, ...args], { encoding: "utf8" });
}

test("launcher owns the combined Plan, Run, Verify help surface", () => {
  const result = launch(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /moemodels plan/);
  assert.match(result.stdout, /moemodels run/);
  assert.match(result.stdout, /moemodels verify/);
});

test("launcher dispatches registry and benchmark commands", () => {
  const registry = launch(["validate", "--json"]);
  assert.equal(registry.status, 0, registry.stderr);
  assert.equal(JSON.parse(registry.stdout).valid, true);

  const benchmark = launch(["verify"]);
  assert.equal(benchmark.status, 2);
  assert.match(benchmark.stderr, /verify requires a passport JSON file/);
});

test("launcher dispatches policy commands", () => {
  const help = launch(["policy", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /moemodels-policy/);
  assert.match(help.stdout, /inconclusive/);

  const check = launch(["policy", "check"]);
  assert.equal(check.status, 2);
  assert.match(check.stderr, /check requires a candidate passport JSON file/);

  const compare = launch(["compare"]);
  assert.equal(compare.status, 2);
  assert.match(compare.stderr, /compare requires a baseline and a candidate/);
});
