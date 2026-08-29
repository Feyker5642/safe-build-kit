import { createHash } from "node:crypto";
import { lstat, mkdtemp, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { VerifyExecution } from "./verify.js";

export interface ReportRecord {
  kind: "safe-build-report";
  version: "0.1";
  semantics: {
    primaryVerdictRef: "results.verify";
    validationVerdictRef: "results.validate";
  };
  results: {
    validate: VerifyExecution["validationResult"];
    verify: VerifyExecution["verifyResult"];
  };
  trace: VerifyExecution["trace"];
}

export function buildReportRecord(execution: VerifyExecution): ReportRecord {
  return {
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
  };
}

export function serializeReportRecord(report: ReportRecord): string {
  return JSON.stringify(report) + "\n";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '\"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

export function renderReportHtml(
  report: ReportRecord,
  reportJson = serializeReportRecord(report),
): string {
  const hash = createHash("sha256")
    .update(Buffer.from(reportJson, "utf8"))
    .digest("hex");
  const content = escapeHtml(reportJson);
  return `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="safe-build-report-json-sha256" content="${hash}"><title>Safe Build Report</title><style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:1rem}.hash{font-family:monospace}</style></head><body><h1>Safe Build Report</h1><p class="hash">report.json SHA-256: ${hash}</p><pre>${content}</pre></body></html>\n`;
}

export function renderReportBundle(execution: VerifyExecution): {
  reportJson: string;
  reportHtml: string;
} {
  const report = buildReportRecord(execution);
  const reportJson = serializeReportRecord(report);
  return { reportJson, reportHtml: renderReportHtml(report, reportJson) };
}

export async function publishReportBundle(
  outputDirectory: string,
  artifacts: { reportJson: string; reportHtml: string },
): Promise<void> {
  const parent = dirname(outputDirectory);
  try {
    await lstat(outputDirectory);
    throw new Error("REPORT_OUTPUT_EXISTS");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(
    join(parent, `.${basename(outputDirectory)}.stage-`),
  );
  await writeFile(join(staging, "report.json"), artifacts.reportJson, {
    encoding: "utf8",
    flag: "wx",
  });
  await writeFile(join(staging, "report.html"), artifacts.reportHtml, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(staging, outputDirectory);
}
