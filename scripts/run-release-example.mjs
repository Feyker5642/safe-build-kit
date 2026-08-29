// What: run the synthetic Safe Build release example through validate, verify, and report.
// Run: node scripts/run-release-example.mjs <existing-parent-directory>
// Needs: Node 24, Git on PATH, built dist files, and one writable existing parent directory.

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const fixtureScriptPath = join(
  projectRoot,
  "scripts",
  "create-action-smoke-fixture.mjs",
);
const cliPath = join(projectRoot, "dist", "cli.js");
const usage = "usage: run-release-example <existing-parent-directory>";

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

function environmentWithoutGitHubOutput() {
  const childEnvironment = { ...process.env };
  for (const name of Object.keys(childEnvironment)) {
    if (name.toUpperCase() === "GITHUB_OUTPUT") {
      delete childEnvironment[name];
    }
  }
  return childEnvironment;
}

function requireExactPass(result) {
  if (
    result.exitCode !== 0 ||
    result.stdout !== "PASS\n" ||
    result.stderr !== ""
  ) {
    throw new Error("command did not produce canonical PASS");
  }
}

async function createFixture(parent) {
  const result = await execFileResult(
    process.execPath,
    [fixtureScriptPath, parent],
    { env: environmentWithoutGitHubOutput() },
  );
  if (result.exitCode !== 0 || result.stderr !== "") {
    throw new Error("fixture creation failed");
  }
  const fixture = JSON.parse(result.stdout.trim());
  if (
    dirname(resolve(fixture.root)) !== parent ||
    typeof fixture.repository !== "string" ||
    typeof fixture["build-pack"] !== "string" ||
    typeof fixture.base !== "string" ||
    typeof fixture.head !== "string" ||
    typeof fixture.evidence !== "string"
  ) {
    throw new Error("fixture output did not match the expected contract");
  }
  return fixture;
}

async function runCanonicalPassStep(name, arguments_, completedSteps) {
  const result = await execFileResult(process.execPath, [
    cliPath,
    ...arguments_,
  ]);
  requireExactPass(result);
  completedSteps.push(name);
}

function verificationArguments(fixture) {
  return [
    fixture["build-pack"],
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

async function main() {
  const [parentArgument, ...extraArguments] = process.argv.slice(2);
  if (
    parentArgument === undefined ||
    parentArgument.trim() === "" ||
    extraArguments.length > 0
  ) {
    process.stderr.write(`OPERATIONAL_ERROR\n${usage}\n`);
    process.exitCode = 2;
    return;
  }
  const outputParent = resolve(parentArgument);
  const parentStat = await stat(outputParent);
  if (!parentStat.isDirectory()) throw new Error("parent is not a directory");

  const fixture = await createFixture(outputParent);
  const completedSteps = [];
  await runCanonicalPassStep(
    "validate",
    ["validate", fixture["build-pack"]],
    completedSteps,
  );
  await runCanonicalPassStep(
    "verify",
    ["verify", ...verificationArguments(fixture)],
    completedSteps,
  );

  const reportDirectory = join(fixture.root, "report");
  await runCanonicalPassStep(
    "report",
    [
      "report",
      ...verificationArguments(fixture),
      "--out",
      reportDirectory,
    ],
    completedSteps,
  );

  const reportJson = join(reportDirectory, "report.json");
  const reportHtml = join(reportDirectory, "report.html");
  const [jsonStat, htmlStat, report] = await Promise.all([
    stat(reportJson),
    stat(reportHtml),
    readFile(reportJson, "utf8").then(JSON.parse),
  ]);
  if (
    !jsonStat.isFile() ||
    !htmlStat.isFile() ||
    jsonStat.size === 0 ||
    htmlStat.size === 0 ||
    report.results?.validate?.status !== "PASS" ||
    report.results?.verify?.status !== "PASS" ||
    report.results?.verify?.exitCode !== 0
  ) {
    throw new Error("report did not preserve canonical PASS");
  }

  process.stdout.write(
    `${JSON.stringify({
      kind: "safe-build-release-example",
      version: "0.1",
      status: "PASS",
      steps: completedSteps,
      root: fixture.root,
      repository: fixture.repository,
      buildPack: fixture["build-pack"],
      base: fixture.base,
      head: fixture.head,
      evidence: fixture.evidence,
      reportJson,
      reportHtml,
    })}\n`,
  );
}

try {
  await main();
} catch {
  process.stderr.write("RELEASE_EXAMPLE_FAILED\n");
  process.exitCode = 2;
}
