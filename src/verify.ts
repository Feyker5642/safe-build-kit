import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { AnySchema } from "ajv";

import {
  buildPackFiles,
  createStrictAjv,
  inspectBuildPack,
  issuePath,
  parseSafeYaml,
  type ArtifactContractDocument,
  type BuildPackFile,
  type LoadedBuildPack,
  type ValidationIssue,
  type ValidationResult,
} from "./validate.js";

export type VerifyStatus =
  | "PASS"
  | "FAIL"
  | "OPERATIONAL_ERROR"
  | "BLOCKED";

export interface VerifyOptions {
  buildPackDirectory: string;
  repository: string;
  baseRef: string;
  headRef: string;
  evidenceDirectory: string;
}

export interface VerifyResult {
  status: VerifyStatus;
  exitCode: 0 | 1 | 2 | 3;
  issues: ValidationIssue[];
}

export interface EvidenceArtifactObservation {
  id: string;
  path: string;
  declaredHash: string;
  observedHash: string | null;
  status: "passed" | "failed" | "unknown" | null;
}

export interface VerificationTrace {
  buildPack: {
    hash: string | null;
  };
  repository: {
    requestedBaseRef: string;
    requestedHeadRef: string;
    baseCommit: string | null;
    headCommit: string | null;
    changedPaths: string[] | null;
  };
  evidence: {
    manifestHash: string | null;
    artifacts: EvidenceArtifactObservation[] | null;
  };
}

export interface VerifyExecution {
  validationResult: ValidationResult;
  verifyResult: VerifyResult;
  trace: VerificationTrace;
}

type IssueCategory = Exclude<VerifyStatus, "PASS">;

interface CategorizedIssue extends ValidationIssue {
  category: IssueCategory;
}

interface EvidenceArtifact {
  id: string;
  path: string;
  sha256: string;
  status?: "passed" | "failed" | "unknown";
}

interface EvidenceManifest {
  version: "0.1";
  buildPackHash: string;
  baseCommit: string;
  headCommit: string;
  artifacts: EvidenceArtifact[];
}

interface StableFileRead {
  content: Buffer | null;
  sha256: string;
  size: number;
}

const GIT_EXECUTABLE = "git";
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;
const MANIFEST_SIZE_LIMIT = 1 * 1024 * 1024;
const ARTIFACT_SIZE_LIMIT = 10 * 1024 * 1024;
const TOTAL_ARTIFACT_SIZE_LIMIT = 50 * 1024 * 1024;
const MANIFEST_FILE = "evidence-manifest.yaml";
const STATUS_ARTIFACT_TYPES = new Set([
  "test_results",
  "build_results",
  "isolation_evidence",
  "human_acceptance",
]);

let manifestValidatorPromise: Promise<ValidateFunction> | undefined;

class StableOperationalError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function issue(
  category: IssueCategory,
  file: string,
  path: string,
  reason: string,
): CategorizedIssue {
  return { category, file, path, reason };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resultFromIssues(issues: CategorizedIssue[]): VerifyResult {
  const sorted = [...issues].sort(
    (left, right) =>
      compareText(left.file, right.file) ||
      compareText(left.path, right.path) ||
      compareText(left.reason, right.reason),
  );
  const status: VerifyStatus = sorted.some(
    (entry) => entry.category === "OPERATIONAL_ERROR",
  )
    ? "OPERATIONAL_ERROR"
    : sorted.some((entry) => entry.category === "FAIL")
      ? "FAIL"
      : sorted.some((entry) => entry.category === "BLOCKED")
        ? "BLOCKED"
        : "PASS";
  const exitCode = status === "PASS" ? 0 : status === "FAIL" ? 1 : status === "OPERATIONAL_ERROR" ? 2 : 3;
  return {
    status,
    exitCode,
    issues: sorted.map(({ file, path, reason }) => ({ file, path, reason })),
  };
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LC_ALL: "C",
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function runGit(arguments_: string[]): Promise<Buffer> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(GIT_EXECUTABLE, arguments_, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnvironment(),
    });
    const stdout: Buffer[] = [];
    let stdoutSize = 0;
    let rejected = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (rejected) return;
      stdoutSize += chunk.byteLength;
      if (stdoutSize > GIT_OUTPUT_LIMIT) {
        rejected = true;
        child.kill();
        rejectOutput(new StableOperationalError("GIT_OUTPUT_TOO_LARGE"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => {
      if (!rejected) rejectOutput(new StableOperationalError("GIT_EXECUTION_FAILED"));
    });
    child.on("close", (code) => {
      if (rejected) return;
      if (code !== 0) {
        rejectOutput(new StableOperationalError("GIT_COMMAND_FAILED"));
        return;
      }
      resolveOutput(Buffer.concat(stdout));
    });
  });
}

function decodeUtf8(bytes: Buffer, code: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StableOperationalError(code);
  }
}

async function confirmGitRepository(repository: string): Promise<void> {
  let output: Buffer;
  try {
    output = await runGit([
      "--no-pager",
      "-C",
      repository,
      "rev-parse",
      "--is-inside-work-tree",
    ]);
  } catch (error: unknown) {
    if (
      error instanceof StableOperationalError &&
      error.code === "GIT_COMMAND_FAILED"
    ) {
      throw new StableOperationalError("NOT_A_GIT_REPOSITORY");
    }
    throw error;
  }
  if (decodeUtf8(output, "GIT_REPOSITORY_OUTPUT_INVALID").trim() !== "true") {
    throw new StableOperationalError("NOT_A_GIT_REPOSITORY");
  }
}

async function resolveCommit(repository: string, ref: string): Promise<string> {
  let output: Buffer;
  try {
    output = await runGit([
      "--no-pager",
      "-C",
      repository,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
  } catch (error: unknown) {
    if (
      error instanceof StableOperationalError &&
      error.code === "GIT_COMMAND_FAILED"
    ) {
      throw new StableOperationalError("GIT_REF_NOT_COMMIT");
    }
    throw error;
  }
  const oid = decodeUtf8(output, "GIT_REF_OUTPUT_INVALID").trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
    throw new StableOperationalError("GIT_REF_OUTPUT_INVALID");
  }
  return oid;
}

async function changedGitPaths(
  repository: string,
  baseCommit: string,
  headCommit: string,
): Promise<string[]> {
  const output = await runGit([
    "--no-pager",
    "-C",
    repository,
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    baseCommit,
    headCommit,
    "--",
  ]);
  if (output.byteLength === 0) return [];
  if (output[output.byteLength - 1] !== 0) {
    throw new StableOperationalError("GIT_PATH_OUTPUT_INVALID");
  }

  const paths: string[] = [];
  let start = 0;
  for (let index = 0; index < output.byteLength; index += 1) {
    if (output[index] !== 0) continue;
    const bytes = output.subarray(start, index);
    if (bytes.byteLength === 0) {
      throw new StableOperationalError("GIT_PATH_OUTPUT_INVALID");
    }
    paths.push(decodeUtf8(bytes, "GIT_PATH_ENCODING_UNSUPPORTED"));
    start = index + 1;
  }
  return paths.sort(compareText);
}

function validatePolicyPath(path: string): string | null {
  if (path.includes("\0")) return "POLICY_PATH_NUL";
  if (path.includes("\\")) return "POLICY_PATH_BACKSLASH";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return "POLICY_PATH_ABSOLUTE";
  }
  if (/[*?\[\]]/.test(path)) return "POLICY_PATH_GLOB_UNSUPPORTED";

  const value = path.endsWith("/") ? path.slice(0, -1) : path;
  if (value.length === 0) return "POLICY_PATH_EMPTY";
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return "POLICY_PATH_EMPTY_SEGMENT";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "POLICY_PATH_DOT_SEGMENT";
  }
  return null;
}

function policyPathMatches(rule: string, changedPath: string): boolean {
  return rule.endsWith("/")
    ? changedPath.startsWith(rule)
    : changedPath === rule;
}

function validateEvidencePath(path: string): string | null {
  if (path.includes("\0")) return "EVIDENCE_PATH_NUL";
  if (path.includes("\\")) return "EVIDENCE_PATH_BACKSLASH";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || isAbsolute(path)) {
    return "EVIDENCE_PATH_ABSOLUTE";
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return "EVIDENCE_PATH_EMPTY_SEGMENT";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "EVIDENCE_PATH_DOT_SEGMENT";
  }
  return null;
}

function isContained(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(pathFromRoot)
  );
}

async function readStableFile(
  path: string,
  maximumSize: number,
  includeContent: boolean,
  sizeCode = "EVIDENCE_FILE_TOO_LARGE",
): Promise<StableFileRead> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    throw new StableOperationalError("EVIDENCE_FILE_UNREADABLE");
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new StableOperationalError("EVIDENCE_FILE_NOT_REGULAR");
    }
    if (before.size > maximumSize) {
      throw new StableOperationalError(sizeCode);
    }

    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < before.size) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, before.size - position));
      const { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.byteLength,
        position,
      );
      if (bytesRead === 0) break;
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      if (includeContent) chunks.push(bytes);
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      position !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new StableOperationalError("INPUT_CHANGED_DURING_VERIFICATION");
    }
    return {
      content: includeContent ? Buffer.concat(chunks) : null,
      sha256: hash.digest("hex"),
      size: before.size,
    };
  } finally {
    await handle.close();
  }
}

async function evidenceRoot(directory: string): Promise<{
  root: string;
  realRoot: string;
}> {
  const root = resolve(directory);
  let status;
  try {
    status = await lstat(root);
  } catch {
    throw new StableOperationalError("EVIDENCE_ROOT_UNREADABLE");
  }
  if (status.isSymbolicLink()) {
    throw new StableOperationalError("EVIDENCE_ROOT_SYMLINK");
  }
  if (!status.isDirectory()) {
    throw new StableOperationalError("EVIDENCE_ROOT_NOT_DIRECTORY");
  }
  return { root, realRoot: await realpath(root) };
}

async function readEvidenceFile(
  root: string,
  realRoot: string,
  path: string,
  maximumSize: number,
  includeContent: boolean,
  sizeCode = "EVIDENCE_FILE_TOO_LARGE",
): Promise<StableFileRead> {
  const pathIssue = validateEvidencePath(path);
  if (pathIssue !== null) throw new StableOperationalError(pathIssue);

  let current = root;
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let status;
    try {
      status = await lstat(current);
    } catch {
      throw new StableOperationalError("EVIDENCE_FILE_MISSING");
    }
    if (status.isSymbolicLink()) {
      throw new StableOperationalError("EVIDENCE_PATH_SYMLINK");
    }
    if (index < segments.length - 1 && !status.isDirectory()) {
      throw new StableOperationalError("EVIDENCE_PATH_NOT_DIRECTORY");
    }
    if (index === segments.length - 1 && !status.isFile()) {
      throw new StableOperationalError("EVIDENCE_FILE_NOT_REGULAR");
    }
    if (index === segments.length - 1 && status.size > maximumSize) {
      throw new StableOperationalError(sizeCode);
    }
  }

  let realTarget: string;
  try {
    realTarget = await realpath(current);
  } catch {
    throw new StableOperationalError("EVIDENCE_FILE_UNREADABLE");
  }
  if (!isContained(realRoot, realTarget)) {
    throw new StableOperationalError("EVIDENCE_PATH_ESCAPE");
  }
  return readStableFile(current, maximumSize, includeContent, sizeCode);
}

async function getManifestValidator(): Promise<ValidateFunction> {
  manifestValidatorPromise ??= (async () => {
    const schemaUrl = new URL(
      "./schemas/evidence-manifest.schema.json",
      import.meta.url,
    );
    const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as AnySchema;
    return createStrictAjv().compile(schema);
  })();
  return manifestValidatorPromise;
}

function schemaIssues(errors: ErrorObject[] | null | undefined): CategorizedIssue[] {
  return (errors ?? []).map((error) =>
    issue(
      "OPERATIONAL_ERROR",
      MANIFEST_FILE,
      issuePath(error),
      `MANIFEST_SCHEMA ${error.message ?? "schema validation failed"}`,
    ),
  );
}

function computeBuildPackHashFromRaw(
  rawFiles: Record<BuildPackFile, Buffer>,
): string {
  const hash = createHash("sha256");
  hash.update("safe-build-pack-v1\0", "utf8");
  for (const filename of buildPackFiles) {
    const content = rawFiles[filename];
    hash.update(filename, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(content.byteLength), "ascii");
    hash.update("\0", "utf8");
    hash.update(content);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function computeBuildPackHash(buildPack: LoadedBuildPack): string {
  return computeBuildPackHashFromRaw(buildPack.rawFiles);
}

async function currentBuildPackHash(directory: string): Promise<string> {
  const rawFiles = {} as Record<BuildPackFile, Buffer>;
  for (const filename of buildPackFiles) {
    const file = await readStableFile(
      join(directory, filename),
      Number.MAX_SAFE_INTEGER,
      true,
    );
    if (file.content === null) {
      throw new StableOperationalError("BUILD_PACK_READ_FAILED");
    }
    rawFiles[filename] = file.content;
  }
  return computeBuildPackHashFromRaw(rawFiles);
}

function mappedBuildPackIssues(
  status: "VALIDATION_FAIL" | "OPERATIONAL_ERROR",
  issues: ValidationIssue[],
): CategorizedIssue[] {
  const category = status === "VALIDATION_FAIL" ? "FAIL" : "OPERATIONAL_ERROR";
  return issues.map((entry) =>
    issue(
      category,
      entry.file,
      entry.path,
      `BUILD_PACK_${status} ${entry.reason}`,
    ),
  );
}

function artifactById(contract: ArtifactContractDocument): Map<
  string,
  ArtifactContractDocument["required"][number]
> {
  return new Map(contract.required.map((artifact) => [artifact.id, artifact]));
}

export async function executeVerification(
  options: VerifyOptions,
): Promise<VerifyExecution> {
  const trace: VerificationTrace = {
    buildPack: { hash: null },
    repository: {
      requestedBaseRef: options.baseRef,
      requestedHeadRef: options.headRef,
      baseCommit: null,
      headCommit: null,
      changedPaths: null,
    },
    evidence: {
      manifestHash: null,
      artifacts: null,
    },
  };
  const inspection = await inspectBuildPack(options.buildPackDirectory);
  const complete = (verifyResult: VerifyResult): VerifyExecution => ({
    validationResult: inspection.result,
    verifyResult,
    trace,
  });
  const completeIssues = (issues: CategorizedIssue[]): VerifyExecution =>
    complete(resultFromIssues(issues));

  if (inspection.result.status !== "PASS" || inspection.buildPack === null) {
    return completeIssues(
      mappedBuildPackIssues(
        inspection.result.status as "VALIDATION_FAIL" | "OPERATIONAL_ERROR",
        inspection.result.issues,
      ),
    );
  }

  const buildPack = inspection.buildPack;
  const initialBuildPackHash = computeBuildPackHash(buildPack);
  trace.buildPack.hash = initialBuildPackHash;
  const issues: CategorizedIssue[] = [];
  const policy = buildPack.documents["policy.yaml"];
  const artifactContract = buildPack.documents["artifact-contract.yaml"];

  for (const [kind, paths] of [
    ["allowedPaths", policy.allowedPaths],
    ["forbiddenPaths", policy.forbiddenPaths],
  ] as const) {
    paths.forEach((path, index) => {
      const reason = validatePolicyPath(path);
      if (reason !== null) {
        issues.push(issue("FAIL", "policy.yaml", `/${kind}/${index}`, reason));
      }
    });
  }

  const repository = resolve(options.repository);
  let baseCommit: string;
  let headCommit: string;
  let changedPaths: string[];
  try {
    await confirmGitRepository(repository);
    baseCommit = await resolveCommit(repository, options.baseRef);
    trace.repository.baseCommit = baseCommit;
    headCommit = await resolveCommit(repository, options.headRef);
    trace.repository.headCommit = headCommit;
    changedPaths = await changedGitPaths(repository, baseCommit, headCommit);
    trace.repository.changedPaths = changedPaths;
  } catch (error: unknown) {
    const reason =
      error instanceof StableOperationalError
        ? error.code
        : "GIT_OPERATION_FAILED";
    issues.push(issue("OPERATIONAL_ERROR", "<git>", "<root>", reason));
    return completeIssues(issues);
  }

  for (const path of changedPaths) {
    if (policy.forbiddenPaths.some((rule) => policyPathMatches(rule, path))) {
      issues.push(
        issue("FAIL", "<git>", JSON.stringify(path), "FORBIDDEN_PATH_CHANGED"),
      );
    }
    if (!policy.allowedPaths.some((rule) => policyPathMatches(rule, path))) {
      issues.push(
        issue("FAIL", "<git>", JSON.stringify(path), "PATH_OUTSIDE_ALLOWLIST"),
      );
    }
  }

  let root: string;
  let realRoot: string;
  let manifest: EvidenceManifest;
  try {
    ({ root, realRoot } = await evidenceRoot(options.evidenceDirectory));
    const manifestFile = await readEvidenceFile(
      root,
      realRoot,
      MANIFEST_FILE,
      MANIFEST_SIZE_LIMIT,
      true,
      "MANIFEST_TOO_LARGE",
    );
    if (manifestFile.content === null) {
      throw new StableOperationalError("MANIFEST_READ_FAILED");
    }
    trace.evidence.manifestHash = manifestFile.sha256;
    const parsed = parseSafeYaml(
      MANIFEST_FILE,
      decodeUtf8(manifestFile.content, "MANIFEST_UTF8_INVALID"),
    );
    if (!parsed.ok) {
      issues.push(
        ...parsed.issues.map((entry) =>
          issue(
            "OPERATIONAL_ERROR",
            entry.file,
            entry.path,
            `MANIFEST_${entry.reason}`,
          ),
        ),
      );
      return completeIssues(issues);
    }
    const validator = await getManifestValidator();
    if (!validator(parsed.value)) {
      issues.push(...schemaIssues(validator.errors));
      return completeIssues(issues);
    }
    manifest = parsed.value as EvidenceManifest;
    trace.evidence.artifacts = manifest.artifacts.map((artifact) => ({
      id: artifact.id,
      path: artifact.path,
      declaredHash: artifact.sha256,
      observedHash: null,
      status: artifact.status ?? null,
    }));
  } catch (error: unknown) {
    const reason =
      error instanceof StableOperationalError
        ? error.code
        : "MANIFEST_OPERATION_FAILED";
    issues.push(
      issue("OPERATIONAL_ERROR", MANIFEST_FILE, "<root>", reason),
    );
    return completeIssues(issues);
  }

  const seenManifestIds = new Map<string, number>();
  const contractById = artifactById(artifactContract);
  const profile = buildPack.documents["quest.yaml"].profile;
  manifest.artifacts.forEach((artifact, index) => {
    const firstIndex = seenManifestIds.get(artifact.id);
    if (firstIndex !== undefined) {
      issues.push(
        issue(
          "OPERATIONAL_ERROR",
          MANIFEST_FILE,
          `/artifacts/${index}/id`,
          `DUPLICATE_ARTIFACT_ID first declared at /artifacts/${firstIndex}/id`,
        ),
      );
    } else {
      seenManifestIds.set(artifact.id, index);
    }
    if (!contractById.has(artifact.id)) {
      issues.push(
        issue(
          "OPERATIONAL_ERROR",
          MANIFEST_FILE,
          `/artifacts/${index}/id`,
          "UNKNOWN_ARTIFACT_ID",
        ),
      );
    }
  });

  if (manifest.baseCommit !== baseCommit) {
    issues.push(
      issue("FAIL", MANIFEST_FILE, "/baseCommit", "BASE_COMMIT_MISMATCH"),
    );
  }
  if (manifest.headCommit !== headCommit) {
    issues.push(
      issue("FAIL", MANIFEST_FILE, "/headCommit", "HEAD_COMMIT_MISMATCH"),
    );
  }
  if (manifest.buildPackHash !== initialBuildPackHash) {
    issues.push(
      issue(
        "FAIL",
        MANIFEST_FILE,
        "/buildPackHash",
        "BUILD_PACK_HASH_MISMATCH",
      ),
    );
  }

  for (const [index, artifact] of manifest.artifacts.entries()) {
    const contractArtifact = contractById.get(artifact.id);
    if (contractArtifact === undefined) continue;
    const needsStatus = STATUS_ARTIFACT_TYPES.has(contractArtifact.type);
    if (needsStatus && artifact.status === undefined) {
      issues.push(
        issue(
          "OPERATIONAL_ERROR",
          MANIFEST_FILE,
          `/artifacts/${index}/status`,
          "ARTIFACT_STATUS_REQUIRED",
        ),
      );
    }
    if (!needsStatus && artifact.status !== undefined) {
      issues.push(
        issue(
          "OPERATIONAL_ERROR",
          MANIFEST_FILE,
          `/artifacts/${index}/status`,
          "ARTIFACT_STATUS_FORBIDDEN",
        ),
      );
    }
    if (artifact.status === "failed") {
      issues.push(
        issue(
          "FAIL",
          MANIFEST_FILE,
          `/artifacts/${index}/status`,
          "ARTIFACT_STATUS_FAILED",
        ),
      );
    } else if (artifact.status === "unknown" && contractArtifact.required) {
      issues.push(
        issue(
          "BLOCKED",
          MANIFEST_FILE,
          `/artifacts/${index}/status`,
          "REQUIRED_ARTIFACT_STATUS_UNKNOWN",
        ),
      );
    }
  }

  for (const [index, contractArtifact] of artifactContract.required.entries()) {
    if (contractArtifact.required && !seenManifestIds.has(contractArtifact.id)) {
      const reason =
        profile === "controlled" && contractArtifact.type === "isolation_evidence"
          ? "CONTROLLED_ISOLATION_EVIDENCE_MISSING"
          : profile === "controlled" && contractArtifact.type === "human_acceptance"
            ? "CONTROLLED_HUMAN_ACCEPTANCE_MISSING"
            : "REQUIRED_ARTIFACT_ENTRY_MISSING";
      issues.push(
        issue(
          "BLOCKED",
          "artifact-contract.yaml",
          `/required/${index}`,
          reason,
        ),
      );
    }
  }

  let totalArtifactSize = 0;
  for (const [index, artifact] of manifest.artifacts.entries()) {
    try {
      const remainingSize = TOTAL_ARTIFACT_SIZE_LIMIT - totalArtifactSize;
      const maximumSize = Math.min(ARTIFACT_SIZE_LIMIT, remainingSize);
      const sizeCode =
        remainingSize < ARTIFACT_SIZE_LIMIT
          ? "TOTAL_EVIDENCE_TOO_LARGE"
          : "ARTIFACT_TOO_LARGE";
      const file = await readEvidenceFile(
        root,
        realRoot,
        artifact.path,
        maximumSize,
        false,
        sizeCode,
      );
      totalArtifactSize += file.size;
      trace.evidence.artifacts![index]!.observedHash = file.sha256;
      if (file.sha256 !== artifact.sha256) {
        issues.push(
          issue(
            "FAIL",
            MANIFEST_FILE,
            `/artifacts/${index}/sha256`,
            "ARTIFACT_HASH_MISMATCH",
          ),
        );
      }
    } catch (error: unknown) {
      const reason =
        error instanceof StableOperationalError
          ? error.code
          : "ARTIFACT_OPERATION_FAILED";
      issues.push(
        issue(
          "OPERATIONAL_ERROR",
          MANIFEST_FILE,
          `/artifacts/${index}/path`,
          reason,
        ),
      );
    }
  }

  try {
    const finalBuildPackHash = await currentBuildPackHash(buildPack.directory);
    if (finalBuildPackHash !== initialBuildPackHash) {
      issues.push(
        issue(
          "OPERATIONAL_ERROR",
          "<build-pack>",
          "<root>",
          "INPUT_CHANGED_DURING_VERIFICATION",
        ),
      );
    }
  } catch (error: unknown) {
    const reason =
      error instanceof StableOperationalError
        ? error.code
        : "BUILD_PACK_STABILITY_CHECK_FAILED";
    issues.push(
      issue("OPERATIONAL_ERROR", "<build-pack>", "<root>", reason),
    );
  }

  return completeIssues(issues);
}

export async function verifyDelivery(
  options: VerifyOptions,
): Promise<VerifyResult> {
  const execution = await executeVerification(options);
  return execution.verifyResult;
}
