import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { LineCounter, parseDocument } from "yaml";

export type ValidationStatus =
  | "PASS"
  | "VALIDATION_FAIL"
  | "OPERATIONAL_ERROR";

export interface ValidationIssue {
  file: string;
  path: string;
  reason: string;
}

export interface ValidationResult {
  status: ValidationStatus;
  exitCode: 0 | 1 | 2;
  issues: ValidationIssue[];
}

export const buildPackFiles = [
  "quest.yaml",
  "policy.yaml",
  "acceptance.yaml",
  "artifact-contract.yaml",
] as const;

export type BuildPackFile = (typeof buildPackFiles)[number];

export interface QuestDocument {
  profile: "personal" | "controlled";
  scope: {
    in: string[];
    out: string[];
  };
}

export interface PolicyDocument {
  allowedPaths: string[];
  forbiddenPaths: string[];
  isolationEvidenceRequired: boolean;
}

export interface AcceptanceDocument {
  cases: Array<{
    id: string;
  }>;
}

export interface ArtifactContractDocument {
  required: Array<{
    id: string;
    type: string;
    required: boolean;
  }>;
}

export interface BuildPackDocuments {
  "quest.yaml": QuestDocument;
  "policy.yaml": PolicyDocument;
  "acceptance.yaml": AcceptanceDocument;
  "artifact-contract.yaml": ArtifactContractDocument;
}

export interface LoadedBuildPack {
  directory: string;
  documents: BuildPackDocuments;
  rawFiles: Record<BuildPackFile, Buffer>;
}

export interface BuildPackInspection {
  result: ValidationResult;
  buildPack: LoadedBuildPack | null;
}

export interface SafeYamlResult {
  ok: boolean;
  value: unknown;
  issues: ValidationIssue[];
}

const schemaFiles: Record<BuildPackFile, string> = {
  "quest.yaml": "quest.schema.json",
  "policy.yaml": "policy.schema.json",
  "acceptance.yaml": "acceptance.schema.json",
  "artifact-contract.yaml": "artifact-contract.schema.json",
};

let validatorsPromise:
  | Promise<Record<BuildPackFile, ValidateFunction>>
  | undefined;

function operationalError(issues: ValidationIssue[]): ValidationResult {
  return {
    status: "OPERATIONAL_ERROR",
    exitCode: 2,
    issues,
  };
}

function validationFailure(issues: ValidationIssue[]): ValidationResult {
  return {
    status: "VALIDATION_FAIL",
    exitCode: 1,
    issues,
  };
}

async function createValidators(): Promise<
  Record<BuildPackFile, ValidateFunction>
> {
  const ajv = createStrictAjv();
  const validators = {} as Record<BuildPackFile, ValidateFunction>;

  for (const file of buildPackFiles) {
    const schemaUrl = new URL(`./schemas/${schemaFiles[file]}`, import.meta.url);
    const schema = JSON.parse(
      await readFile(schemaUrl, "utf8"),
    ) as AnySchema;
    validators[file] = ajv.compile(schema);
  }

  return validators;
}

export function createStrictAjv(): Ajv2020 {
  return new Ajv2020({ allErrors: true, strict: true });
}

function getValidators(): Promise<Record<BuildPackFile, ValidateFunction>> {
  validatorsPromise ??= createValidators();
  return validatorsPromise;
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function escapeIssuePathControls(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu,
    (character) =>
      "\\u" +
      character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"),
  );
}

export function issuePath(error: ErrorObject): string {
  let path: string;
  if (
    error.keyword === "required" &&
    "missingProperty" in error.params &&
    typeof error.params.missingProperty === "string"
  ) {
    path = `${error.instancePath}/${escapeJsonPointer(error.params.missingProperty)}`;
  } else if (
    error.keyword === "additionalProperties" &&
    "additionalProperty" in error.params &&
    typeof error.params.additionalProperty === "string"
  ) {
    path = `${error.instancePath}/${escapeJsonPointer(error.params.additionalProperty)}`;
  } else {
    path = error.instancePath || "<root>";
  }

  return escapeIssuePathControls(path);
}

export function parseSafeYaml(
  file: string,
  content: string,
): SafeYamlResult {
  try {
    const lineCounter = new LineCounter();
    const document = parseDocument(content, {
      lineCounter,
      prettyErrors: false,
      schema: "core",
    });
    const diagnostics = [...document.errors, ...document.warnings].sort(
      (left, right) => {
        const positionOrder =
          left.pos[0] - right.pos[0] || left.pos[1] - right.pos[1];
        if (positionOrder !== 0) return positionOrder;
        return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
      },
    );

    if (diagnostics.length > 0) {
      return {
        ok: false,
        value: undefined,
        issues: diagnostics.map((diagnostic) => {
          const { line, col } =
            diagnostic.pos[0] < 0
              ? { line: 0, col: 0 }
              : lineCounter.linePos(diagnostic.pos[0]);
          return {
            file,
            path: `line ${line}, column ${col}`,
            reason: `YAML ${diagnostic.code}`,
          };
        }),
      };
    }

    return { ok: true, value: document.toJS() as unknown, issues: [] };
  } catch {
    return {
      ok: false,
      value: undefined,
      issues: [
        {
          file,
          path: "<root>",
          reason: "YAML PARSER_FAILURE",
        },
      ],
    };
  }
}

function addDuplicateIdIssues(
  items: Array<{ id: string }>,
  file: string,
  basePath: string,
  issues: ValidationIssue[],
): void {
  const firstIndexById = new Map<string, number>();

  items.forEach((item, index) => {
    const firstIndex = firstIndexById.get(item.id);
    if (firstIndex === undefined) {
      firstIndexById.set(item.id, index);
      return;
    }

    issues.push({
      file,
      path: `${basePath}/${index}/id`,
      reason: `duplicate id ${JSON.stringify(item.id)}; first declared at ${basePath}/${firstIndex}/id`,
    });
  });
}

export async function inspectBuildPack(
  directory: string,
): Promise<BuildPackInspection> {
  const buildPackDirectory = resolve(directory);
  const issues: ValidationIssue[] = [];
  const documents = {} as Record<BuildPackFile, unknown>;
  const rawFiles = {} as Record<BuildPackFile, Buffer>;

  for (const file of buildPackFiles) {
    try {
      const fileStatus = await lstat(join(buildPackDirectory, file));
      if (fileStatus.isSymbolicLink()) {
        issues.push({
          file,
          path: "<root>",
          reason: "symbolic links are not allowed",
        });
      } else if (!fileStatus.isFile()) {
        issues.push({
          file,
          path: "<root>",
          reason: "path is not a regular file",
        });
      }
    } catch (error: unknown) {
      const reason =
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "file does not exist"
          : "file cannot be read";
      issues.push({ file, path: "<root>", reason });
    }
  }

  if (issues.length > 0) {
    return { result: operationalError(issues), buildPack: null };
  }

  for (const file of buildPackFiles) {
    let content: Buffer;
    try {
      content = await readFile(join(buildPackDirectory, file));
      rawFiles[file] = content;
    } catch {
      issues.push({
        file,
        path: "<root>",
        reason: "file cannot be read",
      });
      continue;
    }

    const parsed = parseSafeYaml(file, content.toString("utf8"));
    issues.push(...parsed.issues);
    if (parsed.ok) documents[file] = parsed.value;
  }

  if (issues.length > 0) {
    return { result: operationalError(issues), buildPack: null };
  }

  let validators: Record<BuildPackFile, ValidateFunction>;
  try {
    validators = await getValidators();
  } catch {
    return {
      result: operationalError([
        {
          file: "<schemas>",
          path: "<root>",
          reason: "validator schemas cannot be loaded",
        },
      ]),
      buildPack: null,
    };
  }

  for (const file of buildPackFiles) {
    const validator = validators[file];
    if (!validator(documents[file])) {
      for (const error of validator.errors ?? []) {
        issues.push({
          file,
          path: issuePath(error),
          reason: error.message ?? "schema validation failed",
        });
      }
    }
  }

  if (issues.length > 0) {
    return { result: validationFailure(issues), buildPack: null };
  }

  const quest = documents["quest.yaml"] as QuestDocument;
  const policy = documents["policy.yaml"] as PolicyDocument;
  const acceptance = documents["acceptance.yaml"] as AcceptanceDocument;
  const artifactContract = documents[
    "artifact-contract.yaml"
  ] as ArtifactContractDocument;

  if (quest.profile === "controlled" && !policy.isolationEvidenceRequired) {
    issues.push({
      file: "policy.yaml",
      path: "/isolationEvidenceRequired",
      reason: "must be true when quest.profile is controlled",
    });
  }

  if (
    policy.isolationEvidenceRequired &&
    !artifactContract.required.some(
      (artifact) =>
        artifact.type === "isolation_evidence" && artifact.required,
    )
  ) {
    issues.push({
      file: "artifact-contract.yaml",
      path: "/required",
      reason:
        "must include a required isolation_evidence artifact when policy.isolationEvidenceRequired is true",
    });
  }

  if (
    quest.profile === "controlled" &&
    !artifactContract.required.some(
      (artifact) => artifact.type === "human_acceptance" && artifact.required,
    )
  ) {
    issues.push({
      file: "artifact-contract.yaml",
      path: "/required",
      reason:
        "must include a required human_acceptance artifact when quest.profile is controlled",
    });
  }

  const outOfScope = new Set(quest.scope.out);
  quest.scope.in.forEach((entry, index) => {
    if (outOfScope.has(entry)) {
      issues.push({
        file: "quest.yaml",
        path: `/scope/in/${index}`,
        reason: `also appears in scope.out: ${JSON.stringify(entry)}`,
      });
    }
  });

  const forbiddenPaths = new Set(policy.forbiddenPaths);
  policy.allowedPaths.forEach((entry, index) => {
    if (forbiddenPaths.has(entry)) {
      issues.push({
        file: "policy.yaml",
        path: `/allowedPaths/${index}`,
        reason: `also appears in forbiddenPaths: ${JSON.stringify(entry)}`,
      });
    }
  });

  addDuplicateIdIssues(
    acceptance.cases,
    "acceptance.yaml",
    "/cases",
    issues,
  );
  addDuplicateIdIssues(
    artifactContract.required,
    "artifact-contract.yaml",
    "/required",
    issues,
  );

  if (issues.length > 0) {
    return { result: validationFailure(issues), buildPack: null };
  }

  return {
    result: {
      status: "PASS",
      exitCode: 0,
      issues: [],
    },
    buildPack: {
      directory: buildPackDirectory,
      documents: documents as unknown as BuildPackDocuments,
      rawFiles,
    },
  };
}

export async function validateBuildPack(
  directory: string,
): Promise<ValidationResult> {
  return (await inspectBuildPack(directory)).result;
}
