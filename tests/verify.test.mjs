import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, "..");
const exampleBuildPack = resolve(
  projectRoot,
  "examples",
  "quote-intake",
  ".safe-build",
);
const cliPath = resolve(projectRoot, "dist", "cli.js");
const actionBundleDirectory = resolve(projectRoot, "action-dist");
const actionMetadataPath = resolve(projectRoot, "action.yml");
const actionWorkflowPath = resolve(
  projectRoot,
  ".github",
  "workflows",
  "m4-action-smoke.yml",
);
const { executeVerification, verifyDelivery } = await import("../dist/verify.js");
const hostileControlKey =
  "unsafe~/\u0000\n\r\t\u001b\u001f\u007f\u009f\u2028\u2029名稱";
const escapedHostileControlPath =
  "/unsafe~0~1\\u0000\\u000A\\u000D\\u0009\\u001B\\u001F\\u007F\\u009F\\u2028\\u2029名稱";
const buildPackFiles = [
  "quest.yaml",
  "policy.yaml",
  "acceptance.yaml",
  "artifact-contract.yaml",
];

function execFileResult(file, args, options = {}) {
  return new Promise((resolveResult) => {
    execFile(
      file,
      args,
      { encoding: "utf8", ...options },
      (error, stdout, stderr) => {
        resolveResult({
          exitCode: error ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function runGit(repository, args) {
  const result = await execFileResult("git", ["-C", repository, ...args]);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function updateYaml(path, update) {
  const document = parse(await readFile(path, "utf8"));
  await update(document);
  await writeFile(path, stringify(document), "utf8");
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

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function createPersonalFixture() {
  const root = await mkdtemp(join(tmpdir(), "safe-build-kit m2 "));
  const repository = join(root, "repo with spaces 測試");
  const buildPackDirectory = join(root, "pack with spaces");
  const evidenceDirectory = join(root, "evidence with spaces");
  await mkdir(join(repository, "src", "quote-intake"), { recursive: true });
  await mkdir(evidenceDirectory, { recursive: true });
  await cp(exampleBuildPack, buildPackDirectory, { recursive: true });

  await execFileResult("git", ["init", repository]);
  await runGit(repository, ["config", "user.email", "fixture@example.invalid"]);
  await runGit(repository, ["config", "user.name", "Safe Build Fixture"]);
  await writeFile(
    join(repository, "src", "quote-intake", "result.txt"),
    "base\n",
    "utf8",
  );
  await runGit(repository, ["add", "--all"]);
  await runGit(repository, ["commit", "-m", "base"]);
  const baseCommit = await runGit(repository, ["rev-parse", "HEAD"]);

  await writeFile(
    join(repository, "src", "quote-intake", "result.txt"),
    "delivered\n",
    "utf8",
  );
  await runGit(repository, ["add", "--all"]);
  await runGit(repository, ["commit", "-m", "delivery"]);
  const headCommit = await runGit(repository, ["rev-parse", "HEAD"]);

  const artifactContractPath = join(
    buildPackDirectory,
    "artifact-contract.yaml",
  );
  const artifactContract = parse(await readFile(artifactContractPath, "utf8"));
  const artifacts = [];
  for (const requirement of artifactContract.required) {
    const path = `artifacts/${requirement.id}.txt`;
    const absolutePath = join(evidenceDirectory, ...path.split("/"));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${requirement.id}\n`, "utf8");
    const artifact = {
      id: requirement.id,
      path,
      sha256: await sha256(absolutePath),
    };
    if (requirement.type === "test_results") artifact.status = "passed";
    artifacts.push(artifact);
  }

  const manifest = {
    version: "0.1",
    buildPackHash: await hashBuildPack(buildPackDirectory),
    baseCommit,
    headCommit,
    artifacts,
  };
  await writeFile(
    join(evidenceDirectory, "evidence-manifest.yaml"),
    stringify(manifest),
    "utf8",
  );

  return {
    root,
    repository,
    buildPackDirectory,
    evidenceDirectory,
    baseCommit,
    headCommit,
  };
}

async function runVerify(fixture, overrides = {}) {
  const options = { ...fixture, ...overrides };
  return execFileResult(process.execPath, [
    cliPath,
    "verify",
    options.buildPackDirectory,
    "--repo",
    options.repository,
    "--base",
    options.baseCommit,
    "--head",
    options.headCommit,
    "--evidence",
    options.evidenceDirectory,
  ]);
}

function parseGitHubOutputFile(content) {
  const outputs = {};
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^(.*?)<<(.*)$/.exec(lines[index]);
    if (header === null) continue;
    const [, name, delimiter] = header;
    const value = [];
    index += 1;
    while (index < lines.length && lines[index] !== delimiter) {
      value.push(lines[index]);
      index += 1;
    }
    outputs[name] = value.join("\n");
  }
  return outputs;
}

async function runBundledAction(fixture, overrides = {}) {
  const options = { ...fixture, ...overrides };
  const isolatedRoot = await mkdtemp(join(tmpdir(), "safe-build-action "));
  const isolatedBundle = join(isolatedRoot, "action-dist");
  const outputPath = join(isolatedRoot, "github-output.txt");
  await cp(actionBundleDirectory, isolatedBundle, { recursive: true });
  await writeFile(outputPath, "", "utf8");
  const env = {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    NODE_PATH: "",
    "INPUT_BUILD-PACK": options.buildPackDirectory,
    INPUT_REPOSITORY: options.repository,
    INPUT_BASE: options.baseCommit,
    INPUT_HEAD: options.headCommit,
    INPUT_EVIDENCE: options.evidenceDirectory,
  };
  const result = await execFileResult(
    process.execPath,
    [join(isolatedBundle, "index.js")],
    { cwd: fixture.root, env },
  );
  return {
    ...result,
    outputs: parseGitHubOutputFile(await readFile(outputPath, "utf8")),
  };
}

test("executeVerification exposes validation and verification results", async () => {
  const fixture = await createPersonalFixture();
  const execution = await executeVerification({
    buildPackDirectory: fixture.buildPackDirectory,
    repository: fixture.repository,
    baseRef: fixture.baseCommit,
    headRef: fixture.headCommit,
    evidenceDirectory: fixture.evidenceDirectory,
  });

  assert.deepEqual(execution.validationResult, {
    status: "PASS",
    exitCode: 0,
    issues: [],
  });
  assert.deepEqual(execution.verifyResult, {
    status: "PASS",
    exitCode: 0,
    issues: [],
  });

  const manifest = parse(await readFile(manifestPath(fixture), "utf8"));
  assert.deepEqual(execution.trace, {
    buildPack: { hash: await hashBuildPack(fixture.buildPackDirectory) },
    repository: {
      requestedBaseRef: fixture.baseCommit,
      requestedHeadRef: fixture.headCommit,
      baseCommit: fixture.baseCommit,
      headCommit: fixture.headCommit,
      changedPaths: ["src/quote-intake/result.txt"],
    },
    evidence: {
      manifestHash: await sha256(manifestPath(fixture)),
      artifacts: await Promise.all(
        manifest.artifacts.map(async (artifact) => ({
          id: artifact.id,
          path: artifact.path,
          declaredHash: artifact.sha256,
          observedHash: await sha256(
            join(fixture.evidenceDirectory, ...artifact.path.split("/")),
          ),
          status: artifact.status ?? null,
        })),
      ),
    },
  });
});

test("executeVerification maps early validation failures", async () => {
  const fixture = await createPersonalFixture();
  await updateYaml(join(fixture.buildPackDirectory, "quest.yaml"), (quest) => {
    quest.profile = "enterprise";
  });

  const options = {
    buildPackDirectory: fixture.buildPackDirectory,
    repository: fixture.repository,
    baseRef: fixture.baseCommit,
    headRef: fixture.headCommit,
    evidenceDirectory: fixture.evidenceDirectory,
  };
  const execution = await executeVerification(options);

  assert.deepEqual(execution.validationResult, {
    status: "VALIDATION_FAIL",
    exitCode: 1,
    issues: [
      {
        file: "quest.yaml",
        path: "/profile",
        reason: "must be equal to one of the allowed values",
      },
    ],
  });

  assert.equal(execution.verifyResult.status, "FAIL");
  assert.equal(execution.verifyResult.exitCode, 1);
  assert.deepEqual(execution.verifyResult.issues, [
    {
      file: "quest.yaml",
      path: "/profile",
      reason:
        "BUILD_PACK_VALIDATION_FAIL must be equal to one of the allowed values",
    },
  ]);
  assert.deepEqual(execution.trace, {
    buildPack: { hash: null },
    repository: {
      requestedBaseRef: fixture.baseCommit,
      requestedHeadRef: fixture.headCommit,
      baseCommit: null,
      headCommit: null,
      changedPaths: null,
    },
    evidence: {
      manifestHash: null,
      artifacts: null,
    },
  });
});

test("verifyDelivery remains a compatibility projection", async () => {
  const fixture = await createPersonalFixture();
  const options = {
    buildPackDirectory: fixture.buildPackDirectory,
    repository: fixture.repository,
    baseRef: fixture.baseCommit,
    headRef: fixture.headCommit,
    evidenceDirectory: fixture.evidenceDirectory,
  };

  const execution = await executeVerification(options);
  const result = await verifyDelivery(options);

  assert.deepEqual(result, execution.verifyResult);
});
function manifestPath(fixture) {
  return join(fixture.evidenceDirectory, "evidence-manifest.yaml");
}

async function updateManifest(fixture, update) {
  await updateYaml(manifestPath(fixture), update);
}

async function refreshBuildPackHash(fixture) {
  const manifest = parse(await readFile(manifestPath(fixture), "utf8"));
  manifest.buildPackHash = await hashBuildPack(fixture.buildPackDirectory);
  await writeFile(manifestPath(fixture), stringify(manifest), "utf8");
}

async function addContractArtifact(
  fixture,
  { id, type, required = true, status = "passed", content = `${id}\n` },
) {
  await updateYaml(
    join(fixture.buildPackDirectory, "artifact-contract.yaml"),
    (contract) => {
      contract.required.push({
        id,
        type,
        description: `Required ${type} evidence`,
        required,
      });
    },
  );
  const path = `artifacts/${id}.txt`;
  const absolutePath = join(fixture.evidenceDirectory, ...path.split("/"));
  await writeFile(absolutePath, content, "utf8");
  await updateManifest(fixture, (manifest) => {
    const artifact = { id, path, sha256: "" };
    if (
      [
        "test_results",
        "build_results",
        "isolation_evidence",
        "human_acceptance",
      ].includes(type)
    ) {
      artifact.status = status;
    }
    manifest.artifacts.push(artifact);
  });
  const manifest = parse(await readFile(manifestPath(fixture), "utf8"));
  manifest.artifacts.find((artifact) => artifact.id === id).sha256 =
    await sha256(absolutePath);
  manifest.buildPackHash = await hashBuildPack(fixture.buildPackDirectory);
  await writeFile(manifestPath(fixture), stringify(manifest), "utf8");
  return { path, absolutePath };
}

async function createControlledFixture() {
  const fixture = await createPersonalFixture();
  await updateYaml(join(fixture.buildPackDirectory, "quest.yaml"), (quest) => {
    quest.profile = "controlled";
  });
  await updateYaml(join(fixture.buildPackDirectory, "policy.yaml"), (policy) => {
    policy.isolationEvidenceRequired = true;
  });
  await addContractArtifact(fixture, {
    id: "isolation-proof",
    type: "isolation_evidence",
  });
  await addContractArtifact(fixture, {
    id: "human-approval",
    type: "human_acceptance",
  });
  await refreshBuildPackHash(fixture);
  return fixture;
}

async function addChangedCommit(fixture, path, content = "changed\n") {
  const absolutePath = join(fixture.repository, ...path.split("/"));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  await runGit(fixture.repository, ["add", "--all"]);
  await runGit(fixture.repository, ["commit", "-m", `change ${path}`]);
  fixture.headCommit = await runGit(fixture.repository, ["rev-parse", "HEAD"]);
  await updateManifest(fixture, (manifest) => {
    manifest.headCommit = fixture.headCommit;
  });
}

async function addManyAllowedPaths(fixture, count) {
  const directory = join(fixture.repository, "src", "quote-intake");
  const filler = "x".repeat(120);
  for (let start = 0; start < count; start += 100) {
    const end = Math.min(start + 100, count);
    await Promise.all(
      Array.from({ length: end - start }, (_, offset) => {
        const index = String(start + offset).padStart(4, "0");
        return writeFile(
          join(directory, `output-${index}-${filler}.txt`),
          `${index}\n`,
          "utf8",
        );
      }),
    );
  }
  await runGit(fixture.repository, ["add", "--all"]);
  await runGit(fixture.repository, ["commit", "-m", `add ${count} allowed paths`]);
  fixture.headCommit = await runGit(fixture.repository, ["rev-parse", "HEAD"]);
  await updateManifest(fixture, (manifest) => {
    manifest.headCommit = fixture.headCommit;
  });
}

async function updateManifestArtifact(fixture, id, update) {
  await updateManifest(fixture, async (manifest) => {
    const artifact = manifest.artifacts.find((entry) => entry.id === id);
    assert.ok(artifact, `missing manifest artifact ${id}`);
    await update(artifact);
  });
}

async function removeManifestArtifact(fixture, id) {
  await updateManifest(fixture, (manifest) => {
    manifest.artifacts = manifest.artifacts.filter((entry) => entry.id !== id);
  });
}

function assertCategory(result, status, exitCode, reason) {
  assert.equal(result.exitCode, exitCode, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`^${status}\\r?\\n`));
  if (reason !== undefined) assert.match(result.stderr, new RegExp(reason));
}

async function hashTree(root) {
  const hash = createHash("sha256");
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      hash.update(relativePath, "utf8");
      hash.update("\0", "utf8");
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else {
        hash.update(await readFile(absolutePath));
      }
      hash.update("\0", "utf8");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

test("personal commit-to-commit delivery passes through the CLI", async () => {
  const fixture = await createPersonalFixture();

  const result = await runVerify(fixture);

  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "PASS\n",
    stderr: "",
  });
});

test("bundled GitHub Action mirrors the canonical PASS result in isolation", async () => {
  const fixture = await createPersonalFixture();
  const before = {
    repository: await hashTree(fixture.repository),
    buildPack: await hashTree(fixture.buildPackDirectory),
    evidence: await hashTree(fixture.evidenceDirectory),
    head: await runGit(fixture.repository, ["rev-parse", "HEAD"]),
  };
  const expected = await executeVerification({
    buildPackDirectory: fixture.buildPackDirectory,
    repository: fixture.repository,
    baseRef: fixture.baseCommit,
    headRef: fixture.headCommit,
    evidenceDirectory: fixture.evidenceDirectory,
  });

  const action = await runBundledAction(fixture);

  assert.equal(action.exitCode, expected.verifyResult.exitCode, action.stderr);
  assert.equal(action.outputs.status, expected.verifyResult.status);
  assert.equal(
    action.outputs["safe-build-exit-code"],
    String(expected.verifyResult.exitCode),
  );
  assert.deepEqual(
    JSON.parse(action.outputs["result-json"]),
    expected.verifyResult,
  );
  assert.deepEqual(JSON.parse(action.outputs["trace-json"]), expected.trace);
  assert.deepEqual(
    {
      repository: await hashTree(fixture.repository),
      buildPack: await hashTree(fixture.buildPackDirectory),
      evidence: await hashTree(fixture.evidenceDirectory),
      head: await runGit(fixture.repository, ["rev-parse", "HEAD"]),
    },
    before,
  );
});

test("GitHub Action metadata exposes only the bounded M4 contract", async () => {
  const metadata = parse(await readFile(actionMetadataPath, "utf8"));

  assert.deepEqual(Object.keys(metadata.inputs), [
    "build-pack",
    "repository",
    "base",
    "head",
    "evidence",
  ]);
  assert.ok(
    Object.values(metadata.inputs).every((input) => input.required === true),
  );
  assert.deepEqual(Object.keys(metadata.outputs), [
    "status",
    "safe-build-exit-code",
    "result-json",
    "trace-json",
  ]);
  assert.deepEqual(metadata.runs, {
    using: "node24",
    main: "action-dist/index.js",
  });
});

test("M4 pull request workflow is read-only and pins every external Action", async () => {
  const workflowText = await readFile(actionWorkflowPath, "utf8");
  const workflow = parse(workflowText);

  assert.deepEqual(workflow.on, { pull_request: null });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs["m4-action-smoke"]["runs-on"], "ubuntu-latest");
  assert.doesNotMatch(workflowText, /pull_request_target/u);
  assert.doesNotMatch(workflowText, /continue-on-error/u);
  assert.doesNotMatch(workflowText, /secrets\./u);
  const externalUses = [...workflowText.matchAll(/uses:\s+([^\s#]+)/gu)]
    .map((match) => match[1])
    .filter((value) => value !== "./");
  assert.ok(externalUses.length > 0);
  assert.ok(
    externalUses.every((value) => /@[0-9a-f]{40}$/u.test(value)),
    externalUses.join("\n"),
  );
  assert.match(
    workflowText,
    /ref:\s+\$\{\{ github\.event\.pull_request\.head\.sha \}\}/u,
  );
  assert.match(workflowText, /fetch-depth:\s+0/u);
  assert.match(workflowText, /persist-credentials:\s+false/u);
});

test("bundled GitHub Action fails closed before verification on an empty input", async () => {
  const fixture = await createPersonalFixture();

  const action = await runBundledAction(fixture, {
    buildPackDirectory: "",
  });

  assert.equal(action.exitCode, 2, action.stderr);
  assert.deepEqual(action.outputs, {});
  assert.match(action.stdout, /SAFE_BUILD_ACTION_FAILED/);
  assert.equal((action.stdout.match(/^::error /gmu) ?? []).length, 1);
  assert.doesNotMatch(action.stdout, /"trace"/);
});

test("bundled GitHub Action fails closed before partial oversized outputs", async () => {
  const fixture = await createPersonalFixture();
  await addManyAllowedPaths(fixture, 1900);
  const execution = await executeVerification({
    buildPackDirectory: fixture.buildPackDirectory,
    repository: fixture.repository,
    baseRef: fixture.baseCommit,
    headRef: fixture.headCommit,
    evidenceDirectory: fixture.evidenceDirectory,
  });
  const projectedJsonBytes = Buffer.byteLength(
    JSON.stringify(execution.verifyResult) + JSON.stringify(execution.trace),
    "utf16le",
  );
  assert.equal(execution.verifyResult.status, "PASS");
  assert.ok(projectedJsonBytes > 512 * 1024, String(projectedJsonBytes));

  const action = await runBundledAction(fixture);

  assert.equal(action.exitCode, 2, action.stderr);
  assert.deepEqual(action.outputs, {});
  assert.match(action.stdout, /SAFE_BUILD_ACTION_FAILED/);
  assert.equal((action.stdout.match(/^::error /gmu) ?? []).length, 1);
});

test("controlled delivery passes with isolation and human acceptance", async () => {
  const fixture = await createControlledFixture();

  const result = await runVerify(fixture);

  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "PASS\n",
    stderr: "",
  });
});

test("identical inputs produce byte-identical CLI results", async () => {
  const fixture = await createPersonalFixture();

  const first = await runVerify(fixture);
  const second = await runVerify(fixture);

  assert.deepEqual(second, first);
});

test("a changed file outside allowedPaths fails", async () => {
  const fixture = await createPersonalFixture();
  await addChangedCommit(fixture, "outside/result.txt");

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "PATH_OUTSIDE_ALLOWLIST");
});

test("a changed file under a forbidden prefix fails", async () => {
  const fixture = await createPersonalFixture();
  await addChangedCommit(fixture, "customer-data/record.txt");

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "FORBIDDEN_PATH_CHANGED");
});

test("forbidden paths win when a changed file also matches allowedPaths", async () => {
  const fixture = await createPersonalFixture();
  await updateYaml(join(fixture.buildPackDirectory, "policy.yaml"), (policy) => {
    policy.allowedPaths = ["src/"];
    policy.forbiddenPaths.push("src/quote-intake/");
  });
  await refreshBuildPackHash(fixture);

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "FORBIDDEN_PATH_CHANGED");
  assert.doesNotMatch(result.stderr, /PATH_OUTSIDE_ALLOWLIST/);
});

test("a failed test receipt fails", async () => {
  const fixture = await createPersonalFixture();
  await updateManifestArtifact(
    fixture,
    "deterministic-test-results",
    (artifact) => {
      artifact.status = "failed";
    },
  );

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "ARTIFACT_STATUS_FAILED");
});

test("bundled GitHub Action preserves FAIL and emits one fixed annotation", async () => {
  const fixture = await createPersonalFixture();
  await updateManifestArtifact(
    fixture,
    "deterministic-test-results",
    (artifact) => {
      artifact.status = "failed";
    },
  );
  const expected = await executeVerification({
    buildPackDirectory: fixture.buildPackDirectory,
    repository: fixture.repository,
    baseRef: fixture.baseCommit,
    headRef: fixture.headCommit,
    evidenceDirectory: fixture.evidenceDirectory,
  });

  const action = await runBundledAction(fixture);

  assert.equal(action.exitCode, 1, action.stderr);
  assert.equal(action.outputs.status, "FAIL");
  assert.equal(action.outputs["safe-build-exit-code"], "1");
  assert.deepEqual(
    JSON.parse(action.outputs["result-json"]),
    expected.verifyResult,
  );
  assert.deepEqual(JSON.parse(action.outputs["trace-json"]), expected.trace);
  const annotationLines = action.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("::error "));
  assert.equal(annotationLines.length, 1);
  assert.match(action.stdout, /canonical exit code 1/);
  assert.doesNotMatch(annotationLines[0], /ARTIFACT_STATUS_FAILED/);
});

test("a failed build receipt fails", async () => {
  const fixture = await createPersonalFixture();
  await addContractArtifact(fixture, {
    id: "build-receipt",
    type: "build_results",
    status: "failed",
  });

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "ARTIFACT_STATUS_FAILED");
});

test("a failed isolation receipt fails", async () => {
  const fixture = await createControlledFixture();
  await updateManifestArtifact(fixture, "isolation-proof", (artifact) => {
    artifact.status = "failed";
  });

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "ARTIFACT_STATUS_FAILED");
});

test("a rejected human acceptance receipt fails", async () => {
  const fixture = await createControlledFixture();
  await updateManifestArtifact(fixture, "human-approval", (artifact) => {
    artifact.status = "failed";
  });

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "ARTIFACT_STATUS_FAILED");
});

test("an artifact hash mismatch fails", async () => {
  const fixture = await createPersonalFixture();
  await updateManifestArtifact(fixture, "known-limitations", (artifact) => {
    artifact.sha256 = "0".repeat(64);
  });

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "ARTIFACT_HASH_MISMATCH");
});

test("a Build Pack hash mismatch fails", async () => {
  const fixture = await createPersonalFixture();
  await updateManifest(fixture, (manifest) => {
    manifest.buildPackHash = "0".repeat(64);
  });

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "BUILD_PACK_HASH_MISMATCH");
});

test("a manifest commit OID mismatch fails", async () => {
  const fixture = await createPersonalFixture();
  await updateManifest(fixture, (manifest) => {
    manifest.baseCommit = "0".repeat(40);
    manifest.headCommit = "f".repeat(40);
  });

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "BASE_COMMIT_MISMATCH");
  assert.match(result.stderr, /HEAD_COMMIT_MISMATCH/);
});

test("invalid M2 policy path syntax fails", async () => {
  const fixture = await createPersonalFixture();
  await updateYaml(join(fixture.buildPackDirectory, "policy.yaml"), (policy) => {
    policy.allowedPaths = ["src/**"];
  });
  await refreshBuildPackHash(fixture);

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "POLICY_PATH_GLOB_UNSUPPORTED");
});

test("an absent required manifest entry blocks", async () => {
  const fixture = await createPersonalFixture();
  await removeManifestArtifact(fixture, "known-limitations");

  const result = await runVerify(fixture);

  assertCategory(result, "BLOCKED", 3, "REQUIRED_ARTIFACT_ENTRY_MISSING");
});

test("controlled delivery without an isolation entry blocks", async () => {
  const fixture = await createControlledFixture();
  await removeManifestArtifact(fixture, "isolation-proof");

  const result = await runVerify(fixture);

  assertCategory(
    result,
    "BLOCKED",
    3,
    "CONTROLLED_ISOLATION_EVIDENCE_MISSING",
  );
});

test("controlled delivery without a human acceptance entry blocks", async () => {
  const fixture = await createControlledFixture();
  await removeManifestArtifact(fixture, "human-approval");

  const result = await runVerify(fixture);

  assertCategory(
    result,
    "BLOCKED",
    3,
    "CONTROLLED_HUMAN_ACCEPTANCE_MISSING",
  );
});

test("an unknown required status blocks", async () => {
  const fixture = await createPersonalFixture();
  await updateManifestArtifact(
    fixture,
    "deterministic-test-results",
    (artifact) => {
      artifact.status = "unknown";
    },
  );

  const result = await runVerify(fixture);

  assertCategory(
    result,
    "BLOCKED",
    3,
    "REQUIRED_ARTIFACT_STATUS_UNKNOWN",
  );
});

test("bundled GitHub Action preserves BLOCKED as exit 3 failure", async () => {
  const fixture = await createPersonalFixture();
  await updateManifestArtifact(
    fixture,
    "deterministic-test-results",
    (artifact) => {
      artifact.status = "unknown";
    },
  );
  const expected = await executeVerification({
    buildPackDirectory: fixture.buildPackDirectory,
    repository: fixture.repository,
    baseRef: fixture.baseCommit,
    headRef: fixture.headCommit,
    evidenceDirectory: fixture.evidenceDirectory,
  });

  const action = await runBundledAction(fixture);

  assert.equal(action.exitCode, 3, action.stderr);
  assert.equal(action.outputs.status, "BLOCKED");
  assert.equal(action.outputs["safe-build-exit-code"], "3");
  assert.deepEqual(
    JSON.parse(action.outputs["result-json"]),
    expected.verifyResult,
  );
  assert.deepEqual(JSON.parse(action.outputs["trace-json"]), expected.trace);
  assert.match(action.stdout, /canonical exit code 3/);
});

test("an unknown optional status does not block", async () => {
  const fixture = await createPersonalFixture();
  await addContractArtifact(fixture, {
    id: "optional-build-receipt",
    type: "build_results",
    required: false,
    status: "unknown",
  });

  const result = await runVerify(fixture);

  assert.deepEqual(result, { exitCode: 0, stdout: "PASS\n", stderr: "" });
});

test("a missing Git ref is an operational error", async () => {
  const fixture = await createPersonalFixture();

  const result = await runVerify(fixture, { headCommit: "missing-ref" });

  assertCategory(result, "OPERATIONAL_ERROR", 2, "GIT_REF_NOT_COMMIT");
});

test("bundled GitHub Action preserves OPERATIONAL_ERROR as exit 2 failure", async () => {
  const fixture = await createPersonalFixture();
  const expected = await executeVerification({
    buildPackDirectory: fixture.buildPackDirectory,
    repository: fixture.repository,
    baseRef: fixture.baseCommit,
    headRef: "missing-ref",
    evidenceDirectory: fixture.evidenceDirectory,
  });

  const action = await runBundledAction(fixture, {
    headCommit: "missing-ref",
  });

  assert.equal(action.exitCode, 2, action.stderr);
  assert.equal(action.outputs.status, "OPERATIONAL_ERROR");
  assert.equal(action.outputs["safe-build-exit-code"], "2");
  assert.deepEqual(
    JSON.parse(action.outputs["result-json"]),
    expected.verifyResult,
  );
  assert.deepEqual(JSON.parse(action.outputs["trace-json"]), expected.trace);
  assert.match(action.stdout, /canonical exit code 2/);
});

test("a ref resolving to a non-commit is an operational error", async () => {
  const fixture = await createPersonalFixture();
  const blobPath = join(fixture.root, "blob.txt");
  await writeFile(blobPath, "not a commit\n", "utf8");
  const blobOid = await runGit(fixture.repository, ["hash-object", "-w", blobPath]);

  const result = await runVerify(fixture, { headCommit: blobOid });

  assertCategory(result, "OPERATIONAL_ERROR", 2, "GIT_REF_NOT_COMMIT");
});

test("a non-Git repository is an operational error", async () => {
  const fixture = await createPersonalFixture();
  const notRepository = join(fixture.root, "not a repository");
  await mkdir(notRepository);

  const result = await runVerify(fixture, { repository: notRepository });

  assertCategory(result, "OPERATIONAL_ERROR", 2, "NOT_A_GIT_REPOSITORY");
});

test("a missing Git executable preserves the execution error", async () => {
  const fixture = await createPersonalFixture();
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.toLowerCase() !== "path",
    ),
  );
  environment.PATH = "";
  const arguments_ = [
    cliPath,
    "verify",
    fixture.buildPackDirectory,
    "--repo",
    fixture.repository,
    "--base",
    fixture.baseCommit,
    "--head",
    fixture.headCommit,
    "--evidence",
    fixture.evidenceDirectory,
  ];

  const first = await execFileResult(process.execPath, arguments_, {
    env: environment,
  });
  const second = await execFileResult(process.execPath, arguments_, {
    env: environment,
  });

  assertCategory(first, "OPERATIONAL_ERROR", 2, "GIT_EXECUTION_FAILED");
  assert.doesNotMatch(
    first.stderr,
    /NOT_A_GIT_REPOSITORY|GIT_REF_NOT_COMMIT/,
  );
  assert.deepEqual(second, first);
});

test("malformed manifest YAML is an operational error", async () => {
  const fixture = await createPersonalFixture();
  await writeFile(manifestPath(fixture), "version: [\n", "utf8");

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "MANIFEST_YAML");
});

for (const [name, tag] of [
  ["dangerous", "!!js/function"],
  ["unknown", "!unknown"],
]) {
  test(`${name} manifest YAML tags are operational errors`, async () => {
    const fixture = await createPersonalFixture();
    const content = await readFile(manifestPath(fixture), "utf8");
    assert.ok(content.includes('version: "0.1"'));
    await writeFile(
      manifestPath(fixture),
      content.replace('version: "0.1"', `version: ${tag} "0.1"`),
      "utf8",
    );

    const result = await runVerify(fixture);

    assertCategory(result, "OPERATIONAL_ERROR", 2, "TAG_RESOLVE_FAILED");
    assert.doesNotMatch(result.stderr, /node:\d+|YAMLWarning|^\s*at /m);
    assert.doesNotMatch(result.stderr, /[A-Za-z]:[\\/]/);
  });
}

test("manifest schema failure is an operational error", async () => {
  const fixture = await createPersonalFixture();
  await updateManifest(fixture, (manifest) => {
    manifest.unexpected = true;
  });

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "MANIFEST_SCHEMA");
});

test("the dist CLI canonically escapes control characters in manifest issue paths", async () => {
  const fixture = await createPersonalFixture();
  await updateManifest(fixture, (manifest) => {
    manifest[hostileControlKey] = true;
  });

  const first = await runVerify(fixture);
  const second = await runVerify(fixture);
  const normalizedStderr = first.stderr.replaceAll("\r\n", "\n");

  assert.equal(first.exitCode, 2);
  assert.equal(first.stdout, "");
  assert.equal(
    normalizedStderr,
    "OPERATIONAL_ERROR\nevidence-manifest.yaml " +
      escapedHostileControlPath +
      " MANIFEST_SCHEMA must NOT have additional properties\n",
  );
  assert.deepEqual(second, first);
  assert.equal(normalizedStderr.split("\n").length, 3);
  assert.equal(normalizedStderr.includes("\r"), false);
  for (const character of [
    "\u0000",
    "\t",
    "\u001b",
    "\u001f",
    "\u007f",
    "\u009f",
    "\u2028",
    "\u2029",
  ]) {
    assert.equal(first.stderr.includes(character), false);
  }
});

test("duplicate manifest artifact IDs are an operational error", async () => {
  const fixture = await createPersonalFixture();
  await updateManifest(fixture, (manifest) => {
    manifest.artifacts.push(structuredClone(manifest.artifacts[0]));
  });

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "DUPLICATE_ARTIFACT_ID");
});

test("an unknown manifest artifact ID is an operational error", async () => {
  const fixture = await createPersonalFixture();
  await updateManifest(fixture, (manifest) => {
    manifest.artifacts[0].id = "unknown-artifact";
  });

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "UNKNOWN_ARTIFACT_ID");
});

test("an illegal artifact status is an operational error", async () => {
  const fixture = await createPersonalFixture();
  await updateManifestArtifact(
    fixture,
    "deterministic-test-results",
    (artifact) => {
      artifact.status = "maybe";
    },
  );

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "MANIFEST_SCHEMA");
});

test("a missing status on a result artifact is an operational error", async () => {
  const fixture = await createPersonalFixture();
  await updateManifestArtifact(
    fixture,
    "deterministic-test-results",
    (artifact) => {
      delete artifact.status;
    },
  );

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "ARTIFACT_STATUS_REQUIRED");
});

test("a status on a non-result artifact is an operational error", async () => {
  const fixture = await createPersonalFixture();
  await updateManifestArtifact(fixture, "known-limitations", (artifact) => {
    artifact.status = "passed";
  });

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "ARTIFACT_STATUS_FORBIDDEN");
});

test("an explicit failed status fails even for an optional artifact", async () => {
  const fixture = await createPersonalFixture();
  await addContractArtifact(fixture, {
    id: "optional-failed-build",
    type: "build_results",
    required: false,
    status: "failed",
  });

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "ARTIFACT_STATUS_FAILED");
});

test("a present manifest entry with a missing target is an operational error", async () => {
  const fixture = await createPersonalFixture();
  const manifest = parse(await readFile(manifestPath(fixture), "utf8"));
  const artifact = manifest.artifacts.find(
    (entry) => entry.id === "known-limitations",
  );
  await unlink(join(fixture.evidenceDirectory, ...artifact.path.split("/")));

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "EVIDENCE_FILE_MISSING");
});

test("invalid UTF-8 manifest bytes are an operational error", async () => {
  const fixture = await createPersonalFixture();
  await writeFile(manifestPath(fixture), Buffer.from([0xff, 0xfe, 0xfd]));

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "MANIFEST_UTF8_INVALID");
});

for (const [name, path, reason] of [
  ["parent escape", "../secret.txt", "EVIDENCE_PATH_DOT_SEGMENT"],
  ["absolute POSIX", "/secret.txt", "EVIDENCE_PATH_ABSOLUTE"],
  ["drive-letter", "C:/Users/secret.txt", "EVIDENCE_PATH_ABSOLUTE"],
  ["UNC", "//server/share/secret.txt", "EVIDENCE_PATH_ABSOLUTE"],
  ["backslash", "artifacts\\secret.txt", "EVIDENCE_PATH_BACKSLASH"],
]) {
  test(`${name} evidence paths are operational errors`, async () => {
    const fixture = await createPersonalFixture();
    await updateManifestArtifact(fixture, "known-limitations", (artifact) => {
      artifact.path = path;
    });

    const result = await runVerify(fixture);

    assertCategory(result, "OPERATIONAL_ERROR", 2, reason);
  });
}

test("a directory cannot be used as an artifact", async () => {
  const fixture = await createPersonalFixture();
  await mkdir(join(fixture.evidenceDirectory, "artifacts", "not-a-file"));
  await updateManifestArtifact(fixture, "known-limitations", (artifact) => {
    artifact.path = "artifacts/not-a-file";
  });

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "EVIDENCE_FILE_NOT_REGULAR");
});

test("a symlink or junction in an artifact path is an operational error", async (t) => {
  const fixture = await createPersonalFixture();
  const outside = join(fixture.root, "outside evidence");
  const link = join(fixture.evidenceDirectory, "linked");
  await mkdir(outside);
  await writeFile(join(outside, "artifact.txt"), "outside\n", "utf8");
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error instanceof Error && error.code === "EPERM") {
      t.skip("platform did not permit creating a symlink or junction");
      return;
    }
    throw error;
  }
  await updateManifestArtifact(fixture, "known-limitations", (artifact) => {
    artifact.path = "linked/artifact.txt";
  });

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "EVIDENCE_PATH_SYMLINK");
});

test("a symlink or junction evidence root is an operational error", async (t) => {
  const fixture = await createPersonalFixture();
  const linkedRoot = join(fixture.root, "linked evidence root");
  try {
    await symlink(
      fixture.evidenceDirectory,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error instanceof Error && error.code === "EPERM") {
      t.skip("platform did not permit creating a symlink or junction");
      return;
    }
    throw error;
  }

  const result = await runVerify(fixture, { evidenceDirectory: linkedRoot });

  assertCategory(result, "OPERATIONAL_ERROR", 2, "EVIDENCE_ROOT_SYMLINK");
});

test("an unreadable artifact is an operational error where permissions are enforced", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows chmod does not reliably remove read access");
    return;
  }
  const fixture = await createPersonalFixture();
  const manifest = parse(await readFile(manifestPath(fixture), "utf8"));
  const artifact = manifest.artifacts.find(
    (entry) => entry.id === "known-limitations",
  );
  await chmod(join(fixture.evidenceDirectory, ...artifact.path.split("/")), 0);

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "EVIDENCE_FILE_UNREADABLE");
});

test("a manifest over 1 MiB is an operational error", async () => {
  const fixture = await createPersonalFixture();
  await writeFile(
    manifestPath(fixture),
    `#${"x".repeat(1024 * 1024)}\n`,
    "utf8",
  );

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "MANIFEST_TOO_LARGE");
});

test("an artifact over 10 MiB is an operational error", async () => {
  const fixture = await createPersonalFixture();
  const manifest = parse(await readFile(manifestPath(fixture), "utf8"));
  const artifact = manifest.artifacts.find(
    (entry) => entry.id === "known-limitations",
  );
  await writeFile(
    join(fixture.evidenceDirectory, ...artifact.path.split("/")),
    Buffer.alloc(10 * 1024 * 1024 + 1),
  );

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "ARTIFACT_TOO_LARGE");
});

test("total evidence over 50 MiB is an operational error", async () => {
  const fixture = await createPersonalFixture();
  for (let index = 0; index < 6; index += 1) {
    const id = `large-optional-${index}`;
    const artifact = await addContractArtifact(fixture, {
      id,
      type: "known_limitations",
      required: false,
    });
    await writeFile(artifact.absolutePath, Buffer.alloc(9 * 1024 * 1024));
    await updateManifestArtifact(fixture, id, async (entry) => {
      entry.sha256 = await sha256(artifact.absolutePath);
    });
  }

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "TOTAL_EVIDENCE_TOO_LARGE");
});

test("concurrent artifact mutation is an operational error", async () => {
  const fixture = await createPersonalFixture();
  const manifest = parse(await readFile(manifestPath(fixture), "utf8"));
  const artifact = manifest.artifacts.find(
    (entry) => entry.id === "known-limitations",
  );
  const path = join(fixture.evidenceDirectory, ...artifact.path.split("/"));
  await writeFile(path, Buffer.alloc(10 * 1024 * 1024));
  await updateManifestArtifact(fixture, "known-limitations", async (entry) => {
    entry.sha256 = await sha256(path);
  });

  let mutating = true;
  const mutation = (async () => {
    while (mutating) {
      const now = new Date();
      await utimes(path, now, now);
      await new Promise((resolveTick) => setImmediate(resolveTick));
    }
  })();
  const result = await runVerify(fixture);
  mutating = false;
  await mutation;

  assertCategory(
    result,
    "OPERATIONAL_ERROR",
    2,
    "INPUT_CHANGED_DURING_VERIFICATION",
  );
});

test("repository external diff and textconv configuration are never invoked", async () => {
  const fixture = await createPersonalFixture();
  await runGit(fixture.repository, [
    "config",
    "diff.external",
    "definitely-not-a-safe-build-command",
  ]);
  await runGit(fixture.repository, [
    "config",
    "diff.safe-build-test.textconv",
    "definitely-not-a-safe-build-textconv",
  ]);
  await writeFile(
    join(fixture.repository, ".git", "info", "attributes"),
    "src/quote-intake/result.txt diff=safe-build-test\n",
    "utf8",
  );

  const result = await runVerify(fixture);

  assert.deepEqual(result, { exitCode: 0, stdout: "PASS\n", stderr: "" });
});

test("allowedCommands and executable-looking evidence are never executed", async () => {
  const fixture = await createPersonalFixture();
  const marker = join(fixture.root, "must-not-exist.txt");
  await updateYaml(join(fixture.buildPackDirectory, "policy.yaml"), (policy) => {
    policy.allowedCommands = [
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      )}`,
    ];
  });
  const scriptPath = "artifacts/run-tests.ps1";
  const absoluteScriptPath = join(
    fixture.evidenceDirectory,
    ...scriptPath.split("/"),
  );
  await writeFile(
    absoluteScriptPath,
    `Set-Content -LiteralPath ${JSON.stringify(marker)} -Value ran\n`,
    "utf8",
  );
  await updateManifestArtifact(fixture, "known-limitations", (artifact) => {
    artifact.path = scriptPath;
  });
  await updateManifestArtifact(
    fixture,
    "known-limitations",
    async (artifact) => {
      artifact.sha256 = await sha256(absoluteScriptPath);
    },
  );
  await refreshBuildPackHash(fixture);

  const result = await runVerify(fixture);

  assert.deepEqual(result, { exitCode: 0, stdout: "PASS\n", stderr: "" });
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("working-tree and untracked changes are not part of commit verification", async () => {
  const fixture = await createPersonalFixture();
  const untracked = join(fixture.repository, "customer-data", "untracked.txt");
  await mkdir(dirname(untracked), { recursive: true });
  await writeFile(untracked, "working tree only\n", "utf8");

  const result = await runVerify(fixture);

  assert.deepEqual(result, { exitCode: 0, stdout: "PASS\n", stderr: "" });
  assert.equal(await readFile(untracked, "utf8"), "working tree only\n");
});

test("spaces and Unicode Git paths pass under an allowed prefix", async () => {
  const fixture = await createPersonalFixture();
  await addChangedCommit(fixture, "src/quote-intake/結果 with space.txt");

  const result = await runVerify(fixture);

  assert.deepEqual(result, { exitCode: 0, stdout: "PASS\n", stderr: "" });
});

test("a rename is checked as delete plus add with rename detection disabled", async () => {
  const fixture = await createPersonalFixture();
  await mkdir(join(fixture.repository, "customer-data"));
  await runGit(fixture.repository, [
    "mv",
    "src/quote-intake/result.txt",
    "customer-data/result.txt",
  ]);
  await runGit(fixture.repository, ["commit", "-m", "rename outside scope"]);
  fixture.headCommit = await runGit(fixture.repository, ["rev-parse", "HEAD"]);
  await updateManifest(fixture, (manifest) => {
    manifest.headCommit = fixture.headCommit;
  });

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "FORBIDDEN_PATH_CHANGED");
});

test("policy path matching is case-sensitive", async () => {
  const fixture = await createPersonalFixture();
  await updateYaml(join(fixture.buildPackDirectory, "policy.yaml"), (policy) => {
    policy.allowedPaths = ["src/Quote-Intake/"];
  });
  await refreshBuildPackHash(fixture);

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "PATH_OUTSIDE_ALLOWLIST");
});

test("an exact policy file path passes", async () => {
  const fixture = await createPersonalFixture();
  await updateYaml(join(fixture.buildPackDirectory, "policy.yaml"), (policy) => {
    policy.allowedPaths = ["src/quote-intake/result.txt"];
  });
  await refreshBuildPackHash(fixture);

  const result = await runVerify(fixture);

  assert.deepEqual(result, { exitCode: 0, stdout: "PASS\n", stderr: "" });
});

test("M1 validation failures map to verify FAIL", async () => {
  const fixture = await createPersonalFixture();
  await updateYaml(join(fixture.buildPackDirectory, "quest.yaml"), (quest) => {
    quest.profile = "enterprise";
  });

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "BUILD_PACK_VALIDATION_FAIL");
});

test("M1 operational errors map to verify OPERATIONAL_ERROR", async () => {
  const fixture = await createPersonalFixture();
  await unlink(join(fixture.buildPackDirectory, "quest.yaml"));

  const result = await runVerify(fixture);

  assertCategory(
    result,
    "OPERATIONAL_ERROR",
    2,
    "BUILD_PACK_OPERATIONAL_ERROR",
  );
});

test("OPERATIONAL_ERROR has priority over FAIL", async () => {
  const fixture = await createPersonalFixture();
  await updateManifest(fixture, (manifest) => {
    manifest.buildPackHash = "0".repeat(64);
  });
  const manifest = parse(await readFile(manifestPath(fixture), "utf8"));
  const artifact = manifest.artifacts.find(
    (entry) => entry.id === "known-limitations",
  );
  await unlink(join(fixture.evidenceDirectory, ...artifact.path.split("/")));

  const result = await runVerify(fixture);

  assertCategory(result, "OPERATIONAL_ERROR", 2, "EVIDENCE_FILE_MISSING");
  assert.match(result.stderr, /BUILD_PACK_HASH_MISMATCH/);
});

test("FAIL has priority over BLOCKED", async () => {
  const fixture = await createPersonalFixture();
  await updateManifest(fixture, (manifest) => {
    manifest.buildPackHash = "0".repeat(64);
  });
  await removeManifestArtifact(fixture, "known-limitations");

  const result = await runVerify(fixture);

  assertCategory(result, "FAIL", 1, "BUILD_PACK_HASH_MISMATCH");
  assert.match(result.stderr, /REQUIRED_ARTIFACT_ENTRY_MISSING/);
});

test("verify rejects missing, duplicate, and unknown options", async () => {
  for (const arguments_ of [
    ["verify"],
    [
      "verify",
      "pack",
      "--repo",
      "repo",
      "--repo",
      "repo",
      "--base",
      "base",
      "--head",
      "head",
    ],
    [
      "verify",
      "pack",
      "--repo",
      "repo",
      "--base",
      "base",
      "--head",
      "head",
      "--unknown",
      "evidence",
    ],
  ]) {
    const result = await execFileResult(process.execPath, [cliPath, ...arguments_]);
    assertCategory(result, "OPERATIONAL_ERROR", 2, "usage: safe-build verify");
  }
});

test("verification does not modify repositories, Build Packs, Evidence, or refs", async () => {
  const fixture = await createPersonalFixture();
  const before = {
    repositoryStatus: await runGit(fixture.repository, ["status", "--porcelain=v1"]),
    refs: await runGit(fixture.repository, ["show-ref", "--head"]),
    buildPack: await hashTree(fixture.buildPackDirectory),
    evidence: await hashTree(fixture.evidenceDirectory),
  };

  const result = await runVerify(fixture);

  const after = {
    repositoryStatus: await runGit(fixture.repository, ["status", "--porcelain=v1"]),
    refs: await runGit(fixture.repository, ["show-ref", "--head"]),
    buildPack: await hashTree(fixture.buildPackDirectory),
    evidence: await hashTree(fixture.evidenceDirectory),
  };
  assert.deepEqual(result, { exitCode: 0, stdout: "PASS\n", stderr: "" });
  assert.deepEqual(after, before);
});

test("unsupported Git path encoding is an operational error where representable", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows filenames cannot represent this invalid UTF-8 fixture");
    return;
  }
  const fixture = await createPersonalFixture();
  const prefix = Buffer.from(
    join(fixture.repository, "src", "quote-intake", "invalid-"),
  );
  await writeFile(Buffer.concat([prefix, Buffer.from([0xff])]), "invalid\n");
  await runGit(fixture.repository, ["add", "--all"]);
  await runGit(fixture.repository, ["commit", "-m", "invalid utf8 path"]);
  fixture.headCommit = await runGit(fixture.repository, ["rev-parse", "HEAD"]);
  await updateManifest(fixture, (manifest) => {
    manifest.headCommit = fixture.headCommit;
  });

  const result = await runVerify(fixture);

  assertCategory(
    result,
    "OPERATIONAL_ERROR",
    2,
    "GIT_PATH_ENCODING_UNSUPPORTED",
  );
});
