#!/usr/bin/env node

import {
  validateBuildPack,
  type ValidationIssue,
  type ValidationResult,
} from "./validate.js";
import {
  executeVerification,
  verifyDelivery,
  type VerifyOptions,
  type VerifyResult,
} from "./verify.js";
import { publishReportBundle, renderReportBundle } from "./report.js";

const validateUsage = "usage: safe-build validate <directory>";
const verifyUsage =
  "usage: safe-build verify <build-pack-directory> --repo <repository> --base <git-ref> --head <git-ref> --evidence <evidence-directory>";
const reportUsage =
  "usage: safe-build report <build-pack-directory> --repo <repository> --base <git-ref> --head <git-ref> --evidence <evidence-directory> --out <output-directory>";

function formatIssue(issue: ValidationIssue): string {
  return `${issue.file} ${issue.path} ${issue.reason}`;
}

function operationalUsage(usage: string): void {
  console.error("OPERATIONAL_ERROR");
  console.error(usage);
  process.exitCode = 2;
}

function outputResult(result: ValidationResult | VerifyResult): void {
  const output = result.status === "PASS" ? console.log : console.error;
  output(result.status);
  for (const issue of result.issues) output(formatIssue(issue));
  process.exitCode = result.exitCode;
}

function parseVerifyOptions(arguments_: string[]): VerifyOptions | null {
  const [buildPackDirectory, ...optionArguments] = arguments_;
  if (
    buildPackDirectory === undefined ||
    buildPackDirectory.trim().length === 0 ||
    optionArguments.length !== 8
  ) {
    return null;
  }

  const values = new Map<string, string>();
  const allowedOptions = new Set(["--repo", "--base", "--head", "--evidence"]);
  for (let index = 0; index < optionArguments.length; index += 2) {
    const option = optionArguments[index];
    const value = optionArguments[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !allowedOptions.has(option) ||
      values.has(option) ||
      value.trim().length === 0
    ) {
      return null;
    }
    values.set(option, value);
  }

  const repository = values.get("--repo");
  const baseRef = values.get("--base");
  const headRef = values.get("--head");
  const evidenceDirectory = values.get("--evidence");
  if (
    repository === undefined ||
    baseRef === undefined ||
    headRef === undefined ||
    evidenceDirectory === undefined
  ) {
    return null;
  }
  return {
    buildPackDirectory,
    repository,
    baseRef,
    headRef,
    evidenceDirectory,
  };
}

function parseReportOptions(
  arguments_: string[],
): (VerifyOptions & { outputDirectory: string }) | null {
  const [buildPackDirectory, ...optionArguments] = arguments_;
  if (
    buildPackDirectory === undefined ||
    buildPackDirectory.trim() === "" ||
    optionArguments.length !== 10
  ) {
    return null;
  }
  const values = new Map<string, string>();
  const allowed = new Set(["--repo", "--base", "--head", "--evidence", "--out"]);
  for (let index = 0; index < optionArguments.length; index += 2) {
    const key = optionArguments[index];
    const value = optionArguments[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !allowed.has(key) ||
      values.has(key) ||
      value.trim() === ""
    ) {
      return null;
    }
    values.set(key, value);
  }
  const repository = values.get("--repo");
  const baseRef = values.get("--base");
  const headRef = values.get("--head");
  const evidenceDirectory = values.get("--evidence");
  const outputDirectory = values.get("--out");
  if (
    repository === undefined ||
    baseRef === undefined ||
    headRef === undefined ||
    evidenceDirectory === undefined ||
    outputDirectory === undefined
  ) {
    return null;
  }
  return {
    buildPackDirectory,
    repository,
    baseRef,
    headRef,
    evidenceDirectory,
    outputDirectory,
  };
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);

  if (command === "report") {
    const options = parseReportOptions(arguments_);
    if (options === null) {
      operationalUsage(reportUsage);
      return;
    }
    const { outputDirectory, ...verificationOptions } = options;
    const execution = await executeVerification(verificationOptions);
    try {
      const artifacts = renderReportBundle(execution);
      await publishReportBundle(outputDirectory, artifacts);
      outputResult(execution.verifyResult);
    } catch {
      console.error("REPORT_GENERATION_FAILED");
      process.exitCode = 2;
    }
    return;
  }

  if (command === "verify") {
    const options = parseVerifyOptions(arguments_);
    if (options === null) {
      operationalUsage(verifyUsage);
      return;
    }
    outputResult(await verifyDelivery(options));
    return;
  }

  const [directory, ...extra] = arguments_;
  if (
    command !== "validate" ||
    directory === undefined ||
    directory.trim().length === 0 ||
    extra.length > 0
  ) {
    operationalUsage(validateUsage);
    return;
  }
  const result = await validateBuildPack(directory);
  outputResult(result);
}

try {
  await main();
} catch {
  console.error("OPERATIONAL_ERROR");
  console.error("<internal> <root> INTERNAL_ERROR");
  process.exitCode = 2;
}
