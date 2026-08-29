import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, "..");
const releaseScriptPath = resolve(
  projectRoot,
  "scripts",
  "run-release-example.mjs",
);
const fixtureScriptPath = resolve(
  projectRoot,
  "scripts",
  "create-action-smoke-fixture.mjs",
);
const cliPath = resolve(projectRoot, "dist", "cli.js");

function execFileResult(file, arguments_, options = {}) {
  return new Promise((resolveResult) => {
    execFile(
      file,
      arguments_,
      { encoding: "utf8", windowsHide: true, ...options },
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

function environmentWithoutGitHubOutput(environment = process.env) {
  const childEnvironment = { ...environment };
  for (const name of Object.keys(childEnvironment)) {
    if (name.toUpperCase() === "GITHUB_OUTPUT") {
      delete childEnvironment[name];
    }
  }
  return childEnvironment;
}

async function runReleaseExample(parent, options = {}) {
  return execFileResult(process.execPath, [releaseScriptPath, parent], options);
}

function parseSingleJsonLine(stdout) {
  assert.match(stdout, /^\{[^\r\n]*\}\n$/u);
  return JSON.parse(stdout.trimEnd());
}

function verifyArguments(fixture) {
  return [
    cliPath,
    "verify",
    fixture.buildPack ?? fixture["build-pack"],
    "--repo",
    fixture.repository,
    "--base",
    fixture.base,
    "--head",
    fixture.head,
    "--evidence",
    fixture.evidence,
  ];
}

test("release example runs validate, verify, and report into one unique child", async () => {
  const parent = await mkdtemp(join(tmpdir(), "safe-build release parent "));

  const result = await runReleaseExample(parent);

  assert.deepEqual(
    { exitCode: result.exitCode, stderr: result.stderr },
    { exitCode: 0, stderr: "" },
  );
  const summary = parseSingleJsonLine(result.stdout);
  assert.deepEqual(Object.keys(summary), [
    "kind",
    "version",
    "status",
    "steps",
    "root",
    "repository",
    "buildPack",
    "base",
    "head",
    "evidence",
    "reportJson",
    "reportHtml",
  ]);
  assert.equal(summary.kind, "safe-build-release-example");
  assert.equal(summary.version, "0.1");
  assert.equal(summary.status, "PASS");
  assert.deepEqual(summary.steps, ["validate", "verify", "report"]);
  assert.equal(dirname(summary.root), resolve(parent));
  assert.equal(summary.repository, join(summary.root, "repository"));
  assert.equal(summary.buildPack, join(summary.root, "build-pack"));
  assert.equal(summary.evidence, join(summary.root, "evidence"));
  assert.equal(summary.reportJson, join(summary.root, "report", "report.json"));
  assert.equal(summary.reportHtml, join(summary.root, "report", "report.html"));
  assert.equal((await stat(summary.reportJson)).isFile(), true);
  assert.equal((await stat(summary.reportHtml)).isFile(), true);
  assert.deepEqual((await readdir(join(summary.root, "report"))).sort(), [
    "report.html",
    "report.json",
  ]);
  const report = JSON.parse(await readFile(summary.reportJson, "utf8"));
  assert.equal(report.results.validate.status, "PASS");
  assert.equal(report.results.verify.status, "PASS");
  assert.equal(report.results.verify.exitCode, 0);
  assert.ok((await readFile(summary.reportHtml, "utf8")).length > 0);
});

test("release example fails closed before fixture creation when parent is missing", async () => {
  const result = await execFileResult(process.execPath, [releaseScriptPath]);

  assert.deepEqual(result, {
    exitCode: 2,
    stdout: "",
    stderr:
      "OPERATIONAL_ERROR\n" +
      "usage: run-release-example <existing-parent-directory>\n",
  });
});

test("release example isolates fixture stdout from parent GITHUB_OUTPUT", async () => {
  const root = await mkdtemp(join(tmpdir(), "safe-build release Actions "));
  const parent = join(root, "fixtures");
  const githubOutput = join(root, "github-output.txt");
  await mkdir(parent);
  await writeFile(githubOutput, "parent-sentinel\n", "utf8");

  const result = await runReleaseExample(parent, {
    env: { ...process.env, GITHUB_OUTPUT: githubOutput },
  });

  assert.deepEqual(
    { exitCode: result.exitCode, stderr: result.stderr },
    { exitCode: 0, stderr: "" },
  );
  const summary = parseSingleJsonLine(result.stdout);
  assert.equal(summary.status, "PASS");
  assert.deepEqual(summary.steps, ["validate", "verify", "report"]);
  assert.equal(await readFile(githubOutput, "utf8"), "parent-sentinel\n");
});

test("artifact tamper exits 1 and a fresh fixture restores PASS without deletion", async () => {
  const parent = await mkdtemp(join(tmpdir(), "safe-build release tamper "));
  const fixtureResult = await execFileResult(
    process.execPath,
    [fixtureScriptPath, parent],
    { env: environmentWithoutGitHubOutput() },
  );
  assert.deepEqual(
    { exitCode: fixtureResult.exitCode, stderr: fixtureResult.stderr },
    { exitCode: 0, stderr: "" },
  );
  const tamperedFixture = parseSingleJsonLine(fixtureResult.stdout);
  const manifest = parse(
    await readFile(
      join(tamperedFixture.evidence, "evidence-manifest.yaml"),
      "utf8",
    ),
  );
  const artifact = manifest.artifacts[0];
  assert.ok(artifact);
  const artifactPath = join(
    tamperedFixture.evidence,
    ...artifact.path.split("/"),
  );
  await appendFile(artifactPath, "deliberate release tamper\n", "utf8");

  const failed = await execFileResult(
    process.execPath,
    verifyArguments(tamperedFixture),
  );
  assert.equal(failed.exitCode, 1, failed.stderr);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /^FAIL\r?\n/u);
  assert.match(failed.stderr, /ARTIFACT_HASH_MISMATCH/u);

  const restoredResult = await runReleaseExample(parent);
  assert.deepEqual(
    { exitCode: restoredResult.exitCode, stderr: restoredResult.stderr },
    { exitCode: 0, stderr: "" },
  );
  const restoredFixture = parseSingleJsonLine(restoredResult.stdout);
  assert.equal(restoredFixture.status, "PASS");
  assert.notEqual(restoredFixture.root, tamperedFixture.root);

  const restoredVerify = await execFileResult(
    process.execPath,
    verifyArguments(restoredFixture),
  );
  assert.deepEqual(restoredVerify, {
    exitCode: 0,
    stdout: "PASS\n",
    stderr: "",
  });
  assert.equal((await stat(tamperedFixture.root)).isDirectory(), true);
  assert.equal((await stat(restoredFixture.root)).isDirectory(), true);
  assert.deepEqual(
    (await readdir(parent)).sort(),
    [tamperedFixture.root, restoredFixture.root]
      .map((path) => path.slice(parent.length + 1))
      .sort(),
  );
});
