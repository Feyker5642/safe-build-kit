// What: create a synthetic commit-to-commit Build Pack and Evidence fixture for the M4 Action smoke.
// Run: node scripts/create-action-smoke-fixture.mjs <existing-parent-directory>
// Needs: Git on PATH, npm dependencies installed, and a writable parent; creates a new unique child only.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const sourceBuildPack = join(
  projectRoot,
  "examples",
  "quote-intake",
  ".safe-build",
);
const buildPackFiles = [
  "quest.yaml",
  "policy.yaml",
  "acceptance.yaml",
  "artifact-contract.yaml",
];
const outputParent = process.argv[2];
const githubOutput = process.env.GITHUB_OUTPUT;
const execFileAsync = promisify(execFile);

if (outputParent === undefined || outputParent.trim().length === 0) {
  throw new Error("usage: create-action-smoke-fixture <existing-parent-directory>");
}

async function runGit(repository, arguments_) {
  const result = await execFileAsync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function hashBuildPack(buildPackDirectory) {
  const hash = createHash("sha256");
  hash.update("safe-build-pack-v1\0", "utf8");
  for (const filename of buildPackFiles) {
    const content = await readFile(join(buildPackDirectory, filename));
    hash.update(filename, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(content.byteLength), "ascii");
    hash.update("\0", "utf8");
    hash.update(content);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

const root = await mkdtemp(join(resolve(outputParent), "safe-build-m4-smoke-"));
const repository = join(root, "repository");
const buildPackDirectory = join(root, "build-pack");
const evidenceDirectory = join(root, "evidence");
await mkdir(join(repository, "src", "quote-intake"), { recursive: true });
await mkdir(evidenceDirectory);
await cp(sourceBuildPack, buildPackDirectory, { recursive: true });

await runGit(repository, ["init"]);
await runGit(repository, ["config", "user.email", "fixture@example.invalid"]);
await runGit(repository, ["config", "user.name", "Safe Build M4 Fixture"]);
await writeFile(
  join(repository, "src", "quote-intake", "result.txt"),
  "base\n",
  "utf8",
);
await runGit(repository, ["add", "--all"]);
await runGit(repository, ["commit", "-m", "synthetic base"]);
const baseCommit = await runGit(repository, ["rev-parse", "HEAD"]);

await writeFile(
  join(repository, "src", "quote-intake", "result.txt"),
  "delivered\n",
  "utf8",
);
await runGit(repository, ["add", "--all"]);
await runGit(repository, ["commit", "-m", "synthetic delivery"]);
const headCommit = await runGit(repository, ["rev-parse", "HEAD"]);

const contract = parse(
  await readFile(join(buildPackDirectory, "artifact-contract.yaml"), "utf8"),
);
const artifacts = [];
for (const requirement of contract.required) {
  const path = `artifacts/${requirement.id}.txt`;
  const artifactPath = join(evidenceDirectory, ...path.split("/"));
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `synthetic ${requirement.id}\n`, "utf8");
  const artifact = {
    id: requirement.id,
    path,
    sha256: await sha256(artifactPath),
  };
  if (requirement.type === "test_results") artifact.status = "passed";
  artifacts.push(artifact);
}

await writeFile(
  join(evidenceDirectory, "evidence-manifest.yaml"),
  stringify({
    version: "0.1",
    buildPackHash: await hashBuildPack(buildPackDirectory),
    baseCommit,
    headCommit,
    artifacts,
  }),
  "utf8",
);

const outputs = {
  root,
  repository,
  "build-pack": buildPackDirectory,
  base: baseCommit,
  head: headCommit,
  evidence: evidenceDirectory,
};

if (githubOutput !== undefined && githubOutput.length > 0) {
  for (const [name, value] of Object.entries(outputs)) {
    await appendFile(githubOutput, `${name}=${value}\n`, "utf8");
  }
} else {
  process.stdout.write(`${JSON.stringify(outputs)}\n`);
}
