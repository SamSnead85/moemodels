import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseTag = process.env.RELEASE_TAG;
assert.match(releaseTag ?? "", /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "release tag must be v<semver>");
const expectedVersion = releaseTag.slice(1);

for (const manifestPath of [
  "data/v1/package.json",
  "data/evaluations/v1/package.json",
  "packages/core/package.json",
  "packages/ingest/package.json",
  "packages/cli/package.json",
  "packages/bench/package.json",
  "packages/sdk/package.json",
  "packages/mcp/package.json",
  "packages/moemodels/package.json",
]) {
  const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
  assert.equal(manifest.version, expectedVersion, `${manifest.name} does not match ${releaseTag}`);
}

process.stdout.write(`All workspace versions match ${releaseTag}.\n`);
