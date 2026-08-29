import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const {
  buildReportRecord,
  publishReportBundle,
  renderReportBundle,
  serializeReportRecord,
} = await import("../dist/report.js");

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, "..");
const exampleBuildPack = resolve(
  projectRoot,
  "examples",
  "quote-intake",
  ".safe-build",
);
const cliPath = resolve(projectRoot, "dist", "cli.js");
const buildPackFiles = [
  "quest.yaml",
  "policy.yaml",
  "acceptance.yaml",
  "artifact-contract.yaml",
];

const execution = {
  validationResult: {
    status: "PASS",
    exitCode: 0,
    issues: [],
  },
  verifyResult: {
    status: "FAIL",
    exitCode: 1,
    issues: [
      {
        file: "policy.yaml",
        path: "/allowedPaths/0",
        reason: "PATH_OUTSIDE_ALLOWLIST",
      },
    ],
  },
  trace: {
    buildPack: { hash: "build-pack-hash" },
    repository: {
      requestedBaseRef: "base-ref",
      requestedHeadRef: "head-ref",
      baseCommit: "base-commit",
      headCommit: "head-commit",
      changedPaths: ["src/file.ts"],
    },
    evidence: {
      manifestHash: "manifest-hash",
      artifacts: [
        {
          id: "test-results",
          path: "artifacts/test-results.txt",
          declaredHash: "declared-hash",
          observedHash: "observed-hash",
          status: "passed",
        },
      ],
    },
  },
};

Object.freeze(execution.trace.evidence.artifacts[0]);
Object.freeze(execution.trace.evidence.artifacts);
Object.freeze(execution.trace.evidence);
Object.freeze(execution.trace.repository.changedPaths);
Object.freeze(execution.trace.repository);
Object.freeze(execution.trace.buildPack);
Object.freeze(execution.trace);
Object.freeze(execution.validationResult.issues);
Object.freeze(execution.validationResult);
Object.freeze(execution.verifyResult.issues[0]);
Object.freeze(execution.verifyResult.issues);
Object.freeze(execution.verifyResult);
Object.freeze(execution);

function execFileResult(file, arguments_, options = {}) {
  return new Promise((resolveResult) => {
    execFile(
      file,
      arguments_,
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

async function runGit(repository, arguments_) {
  const result = await execFileResult("git", ["-C", repository, ...arguments_]);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
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

async function createPersonalFixture() {
  const root = await mkdtemp(join(tmpdir(), "safe-build-kit m3 "));
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

  const artifactContract = parse(
    await readFile(join(buildPackDirectory, "artifact-contract.yaml"), "utf8"),
  );
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

  return {
    root,
    repository,
    buildPackDirectory,
    evidenceDirectory,
    baseCommit,
    headCommit,
  };
}

function manifestPath(fixture) {
  return join(fixture.evidenceDirectory, "evidence-manifest.yaml");
}

async function updateManifest(fixture, update) {
  const manifest = parse(await readFile(manifestPath(fixture), "utf8"));
  await update(manifest);
  await writeFile(manifestPath(fixture), stringify(manifest), "utf8");
}

async function runReport(fixture, outputDirectory, overrides = {}) {
  const options = { ...fixture, ...overrides };
  return execFileResult(process.execPath, [
    cliPath,
    "report",
    options.buildPackDirectory,
    "--repo",
    options.repository,
    "--base",
    options.baseCommit,
    "--head",
    options.headCommit,
    "--evidence",
    options.evidenceDirectory,
    "--out",
    outputDirectory,
  ]);
}

async function readPublishedReport(outputDirectory) {
  assert.deepEqual((await readdir(outputDirectory)).sort(), [
    "report.html",
    "report.json",
  ]);
  const reportJson = await readFile(join(outputDirectory, "report.json"), "utf8");
  const reportHtml = await readFile(join(outputDirectory, "report.html"), "utf8");
  return { reportJson, reportHtml, report: JSON.parse(reportJson) };
}

test("buildReportRecord projects one execution without a third verdict", () => {
  const report = buildReportRecord(execution);

  assert.deepEqual(report, {
    kind: "safe-build-report",
    version: "0.1",
    semantics: {
      primaryVerdictRef: "results.verify",
      validationVerdictRef: "results.validate",
    },
    results: {
      validate: execution.validationResult,
      verify: execution.verifyResult,
    },
    trace: execution.trace,
  });
  for (const forbidden of [
    "overallStatus",
    "reportVerdict",
    "finalStatus",
    "severity",
  ]) {
    assert.equal(forbidden in report, false, `unexpected ${forbidden}`);
  }
});

test("buildReportRecord preserves every authoritative result status", () => {
  for (const [validationStatus, verifyStatus, verifyExitCode] of [
    ["VALIDATION_FAIL", "FAIL", 1],
    ["PASS", "BLOCKED", 3],
    ["OPERATIONAL_ERROR", "OPERATIONAL_ERROR", 2],
  ]) {
    const input = structuredClone(execution);
    input.validationResult.status = validationStatus;
    input.validationResult.exitCode = validationStatus === "PASS" ? 0 : validationStatus === "VALIDATION_FAIL" ? 1 : 2;
    input.verifyResult.status = verifyStatus;
    input.verifyResult.exitCode = verifyExitCode;

    const report = buildReportRecord(input);

    assert.deepEqual(report.results, {
      validate: input.validationResult,
      verify: input.verifyResult,
    });
    assert.equal("overallStatus" in report, false);
    assert.equal("reportVerdict" in report, false);
    assert.equal("finalStatus" in report, false);
    assert.equal("severity" in report, false);
  }
});

test("serializeReportRecord is deterministic JSON with one trailing newline", () => {
  const first = serializeReportRecord(buildReportRecord(structuredClone(execution)));
  const second = serializeReportRecord(buildReportRecord(structuredClone(execution)));

  assert.equal(first, second);
  assert.equal(first.endsWith("\n"), true);
  assert.equal(first.endsWith("\n\n"), false);
  assert.doesNotMatch(first, /[A-Za-z]:[\\\\/]/);
  assert.doesNotMatch(first, /(?:timestamp|createdAt|updatedAt|random|uuid)/i);
});

test("renderReportBundle binds deterministic offline HTML to escaped JSON", () => {
  const hostileExecution = structuredClone(execution);
  hostileExecution.verifyResult.issues[0].reason =
    "</script><script>alert(\"unsafe\")</script>&";

  const first = renderReportBundle(hostileExecution);
  const second = renderReportBundle(structuredClone(hostileExecution));
  const expectedHash = createHash("sha256")
    .update(Buffer.from(first.reportJson, "utf8"))
    .digest("hex");

  assert.deepEqual(first, second);
  assert.equal(
    first.reportJson,
    serializeReportRecord(buildReportRecord(hostileExecution)),
  );
  assert.match(first.reportHtml, new RegExp(expectedHash));
  assert.match(first.reportHtml, /&lt;\/script&gt;/);
  assert.doesNotMatch(first.reportHtml, /<script\b/i);
  assert.doesNotMatch(first.reportHtml, /https?:\/\/|<link\b|<img\b/i);
  assert.equal(first.reportHtml.endsWith("\n"), true);
  assert.equal(first.reportHtml.endsWith("\n\n"), false);
});

test("publishReportBundle publishes exactly two complete files", async () => {
  const root = await mkdtemp(join(tmpdir(), "safe-build-kit m3 publish "));
  const outputDirectory = join(root, "bundle");
  const artifacts = renderReportBundle(execution);

  await publishReportBundle(outputDirectory, artifacts);

  const published = await readPublishedReport(outputDirectory);
  assert.equal(published.reportJson, artifacts.reportJson);
  assert.equal(published.reportHtml, artifacts.reportHtml);
  assert.deepEqual(await readdir(root), ["bundle"]);
});

test("report CLI publishes a deterministic PASS bundle without modifying inputs", async () => {
  const fixture = await createPersonalFixture();
  const firstOutput = join(fixture.root, "report first");
  const secondOutput = join(fixture.root, "report second");
  const before = {
    repository: await hashTree(fixture.repository),
    buildPack: await hashTree(fixture.buildPackDirectory),
    evidence: await hashTree(fixture.evidenceDirectory),
  };

  const firstResult = await runReport(fixture, firstOutput);
  const secondResult = await runReport(fixture, secondOutput);
  const first = await readPublishedReport(firstOutput);
  const second = await readPublishedReport(secondOutput);

  assert.deepEqual(firstResult, { exitCode: 0, stdout: "PASS\n", stderr: "" });
  assert.deepEqual(secondResult, firstResult);
  assert.equal(first.report.results.verify.status, "PASS");
  assert.equal(first.report.results.verify.exitCode, 0);
  assert.equal(first.reportJson, second.reportJson);
  assert.equal(first.reportHtml, second.reportHtml);
  assert.deepEqual(
    {
      repository: await hashTree(fixture.repository),
      buildPack: await hashTree(fixture.buildPackDirectory),
      evidence: await hashTree(fixture.evidenceDirectory),
    },
    before,
  );
});

for (const scenario of [
  {
    name: "FAIL",
    status: "FAIL",
    exitCode: 1,
    prepare: async (fixture) => {
      await updateManifest(fixture, (manifest) => {
        manifest.artifacts.find(
          (artifact) => artifact.id === "deterministic-test-results",
        ).status = "failed";
      });
    },
    overrides: {},
  },
  {
    name: "BLOCKED",
    status: "BLOCKED",
    exitCode: 3,
    prepare: async (fixture) => {
      await updateManifest(fixture, (manifest) => {
        manifest.artifacts = manifest.artifacts.filter(
          (artifact) => artifact.id !== "known-limitations",
        );
      });
    },
    overrides: {},
  },
  {
    name: "verifier OPERATIONAL_ERROR",
    status: "OPERATIONAL_ERROR",
    exitCode: 2,
    prepare: async () => {},
    overrides: { headCommit: "missing-ref" },
  },
]) {
  test(`report CLI preserves ${scenario.name} and still publishes`, async () => {
    const fixture = await createPersonalFixture();
    const outputDirectory = join(fixture.root, `report ${scenario.status}`);
    await scenario.prepare(fixture);

    const result = await runReport(
      fixture,
      outputDirectory,
      scenario.overrides,
    );
    const published = await readPublishedReport(outputDirectory);

    assert.equal(result.exitCode, scenario.exitCode, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`^${scenario.status}\\r?\\n`));
    assert.doesNotMatch(result.stderr, /REPORT_GENERATION_FAILED/);
    assert.equal(published.report.results.verify.status, scenario.status);
    assert.equal(published.report.results.verify.exitCode, scenario.exitCode);
    assert.match(published.reportHtml, new RegExp(scenario.status));
  });
}

test("report-generation failure is distinct and never overwrites output", async () => {
  const fixture = await createPersonalFixture();
  const outputPath = join(fixture.root, "occupied-output");
  await writeFile(outputPath, "sentinel\n", "utf8");

  const result = await runReport(fixture, outputPath);

  assert.deepEqual(result, {
    exitCode: 2,
    stdout: "",
    stderr: "REPORT_GENERATION_FAILED\n",
  });
  assert.equal(await readFile(outputPath, "utf8"), "sentinel\n");
  assert.equal(
    (await readdir(fixture.root)).some((name) =>
      name.startsWith(".occupied-output.stage-"),
    ),
    false,
  );
});

test("report usage rejects a missing output option before verification", async () => {
  const result = await execFileResult(process.execPath, [
    cliPath,
    "report",
    "missing-pack",
    "--repo",
    "missing-repository",
    "--base",
    "base",
    "--head",
    "head",
    "--evidence",
    "missing-evidence",
  ]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^OPERATIONAL_ERROR\r?\n/);
  assert.match(
    result.stderr,
    /usage: safe-build report .* --out <output-directory>/,
  );
  assert.doesNotMatch(result.stderr, /REPORT_GENERATION_FAILED/);
});
