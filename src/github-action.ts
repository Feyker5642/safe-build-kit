import * as core from "@actions/core";
import { executeVerification } from "./verify.js";

const MAX_ACTION_OUTPUT_UTF16_BYTES = 512 * 1024;
const OUTPUT_PROTOCOL_RESERVE_UTF16_BYTES = 4 * 1024;

function requiredInput(name: string): string {
  const value = core.getInput(name, {
    required: true,
    trimWhitespace: true,
  });
  if (value.length === 0) throw new Error("ACTION_INPUT_EMPTY");
  return value;
}

export async function runGitHubAction(): Promise<void> {
  try {
    const execution = await executeVerification({
      buildPackDirectory: requiredInput("build-pack"),
      repository: requiredInput("repository"),
      baseRef: requiredInput("base"),
      headRef: requiredInput("head"),
      evidenceDirectory: requiredInput("evidence"),
    });
    const result = execution.verifyResult;

    const outputs = [
      ["status", result.status],
      ["safe-build-exit-code", String(result.exitCode)],
      ["result-json", JSON.stringify(result)],
      ["trace-json", JSON.stringify(execution.trace)],
    ] as const;
    const projectedOutputBytes = outputs.reduce(
      (total, [name, value]) =>
        total + Buffer.byteLength(`${name}\n${value}\n`, "utf16le"),
      OUTPUT_PROTOCOL_RESERVE_UTF16_BYTES,
    );
    if (projectedOutputBytes > MAX_ACTION_OUTPUT_UTF16_BYTES) {
      throw new Error("ACTION_OUTPUT_BUDGET_EXCEEDED");
    }

    for (const [name, value] of outputs) core.setOutput(name, value);
    core.info(
      JSON.stringify({
        status: result.status,
        exitCode: result.exitCode,
        issueCount: result.issues.length,
      }),
    );

    if (result.exitCode !== 0) {
      core.error(
        `Safe Build verification did not PASS; canonical exit code ${result.exitCode}.`,
        { title: "Safe Build" },
      );
    }
    process.exitCode = result.exitCode;
  } catch {
    core.error("SAFE_BUILD_ACTION_FAILED", { title: "Safe Build Action" });
    process.exitCode = 2;
  }
}

await runGitHubAction();
