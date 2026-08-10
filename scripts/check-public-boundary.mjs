import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedTopLevel = new Set([
  ".git",
  ".github",
  ".gitignore",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "RELEASING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "action.yml",
  "data",
  "docs",
  "node_modules",
  "package-lock.json",
  "package.json",
  "packages",
  "scripts",
]);
const forbiddenNames = new Set([
  ".openai",
  "ADVANCEMENT_STRATEGY_2026.md",
  "PLATFORM_BLUEPRINT.md",
  "PRODUCT_STRATEGY.md",
  "deploy-netlify.yml",
  "netlify.toml",
]);
const allowedDocs = new Set([
  "DEPLOYBENCH_V0_1.md",
  "DEPLOYMENT_PASSPORT_V0_2.md",
  "POLICY_GATE_V0_1.md",
]);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

const topLevel = await readdir(root);
const unexpected = topLevel.filter((entry) => !allowedTopLevel.has(entry));
assert.deepEqual(unexpected, [], `unexpected public-export top-level entries: ${unexpected.join(", ")}`);

const files = await walk(root);
const forbidden = files
  .filter((path) => forbiddenNames.has(path.split("/").at(-1)))
  .map((path) => relative(root, path));
assert.deepEqual(forbidden, [], `private or deployment files crossed the export boundary: ${forbidden.join(", ")}`);

const legacyRepositorySlug = ["moemodels", "ai"].join("-");
const legacyReferences = [];
for (const path of files) {
  const source = await readFile(path, "utf8");
  if (source.includes(legacyRepositorySlug)) legacyReferences.push(relative(root, path));
}
assert.deepEqual(legacyReferences, [], `legacy repository slug crossed the public boundary: ${legacyReferences.join(", ")}`);

const docs = (await readdir(join(root, "docs"))).filter((entry) => !allowedDocs.has(entry));
assert.deepEqual(docs, [], `unexpected public docs: ${docs.join(", ")}`);

for (const workflowPath of [
  "action.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/cut-release-tags.yml",
  ".github/workflows/release.yml",
]) {
  const source = await readFile(join(root, workflowPath), "utf8");
  for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    const reference = match[1];
    if (reference === "./" || reference.startsWith("./")) continue;
    assert.match(reference, /^[^@]+@[a-f0-9]{40}$/, `${workflowPath}: third-party Action must use an immutable 40-character commit SHA`);
  }
}

const expectedRepository = "git+https://github.com/SamSnead85/moemodels.git";
for (const manifestPath of [
  "data/v1/package.json",
  "data/evaluations/v1/package.json",
  "packages/core/package.json",
  "packages/ingest/package.json",
  "packages/cli/package.json",
  "packages/bench/package.json",
  "packages/policy/package.json",
  "packages/sdk/package.json",
  "packages/mcp/package.json",
  "packages/moemodels/package.json",
]) {
  const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
  assert.equal(manifest.repository?.url, expectedRepository, `${manifestPath}: repository URL`);
  assert.equal(manifest.bugs?.url, "https://github.com/SamSnead85/moemodels/issues", `${manifestPath}: bugs URL`);
  assert.equal(manifest.engines?.node, ">=22.13.0", `${manifestPath}: Node engine`);
  assert.equal(manifest.publishConfig?.access, "public", `${manifestPath}: public access`);
  assert.equal(manifest.publishConfig?.registry, "https://registry.npmjs.org/", `${manifestPath}: npm registry`);
  assert.equal(manifest.publishConfig?.provenance, true, `${manifestPath}: provenance`);
}

process.stdout.write("Public export boundary and package metadata are valid.\n");
