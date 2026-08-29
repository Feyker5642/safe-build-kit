import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdtemp,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

import { validateBuildPack } from "../dist/validate.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, "..");
const exampleBuildPack = resolve(
  projectRoot,
  "examples",
  "quote-intake",
  ".safe-build",
);
const controlledBuildPack = resolve(
  projectRoot,
  "tests",
  "fixtures",
  "controlled-valid",
);
const cliPath = resolve(projectRoot, "dist", "cli.js");
const hostileControlKey =
  "unsafe~/\u0000\n\r\t\u001b\u001f\u007f\u009f\u2028\u2029名稱";
const escapedHostileControlPath =
  "/unsafe~0~1\\u0000\\u000A\\u000D\\u0009\\u001B\\u001F\\u007F\\u009F\\u2028\\u2029名稱";

async function copyExampleBuildPack() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "safe-build-kit m1 "));
  const buildPackDirectory = join(temporaryRoot, "pack with spaces");
  await cp(exampleBuildPack, buildPackDirectory, { recursive: true });
  return buildPackDirectory;
}

async function copyBuildPackWithTaggedTitle(tag) {
  const buildPackDirectory = await copyExampleBuildPack();
  const questPath = join(buildPackDirectory, "quest.yaml");
  const title = 'title: "Synthetic cosmetic carton quote intake"';
  const content = await readFile(questPath, "utf8");

  assert.ok(content.includes(title));
  await writeFile(
    questPath,
    content.replace(title, `title: ${tag} "Synthetic cosmetic carton quote intake"`),
    "utf8",
  );
  return buildPackDirectory;
}

async function hashBuildPack(buildPackDirectory) {
  const hash = createHash("sha256");
  for (const file of [
    "quest.yaml",
    "policy.yaml",
    "acceptance.yaml",
    "artifact-contract.yaml",
  ]) {
    hash.update(file);
    hash.update(await readFile(join(buildPackDirectory, file)));
  }
  return hash.digest("hex");
}

async function updateDocument(buildPackDirectory, file, update) {
  const path = join(buildPackDirectory, file);
  const document = parse(await readFile(path, "utf8"));
  update(document);
  await writeFile(path, stringify(document), "utf8");
}

function requiredArtifact(id, type) {
  return {
    id,
    type,
    description: `Required ${type} evidence`,
    required: true,
  };
}

async function makeControlledPack(
  buildPackDirectory,
  {
    isolationEvidenceRequired = true,
    includeIsolationEvidence = true,
    includeHumanAcceptance = true,
  } = {},
) {
  await updateDocument(buildPackDirectory, "quest.yaml", (quest) => {
    quest.profile = "controlled";
  });
  await updateDocument(buildPackDirectory, "policy.yaml", (policy) => {
    policy.isolationEvidenceRequired = isolationEvidenceRequired;
  });
  await updateDocument(
    buildPackDirectory,
    "artifact-contract.yaml",
    (artifactContract) => {
      if (includeIsolationEvidence) {
        artifactContract.required.push(
          requiredArtifact("isolation-proof", "isolation_evidence"),
        );
      }
      if (includeHumanAcceptance) {
        artifactContract.required.push(
          requiredArtifact("human-approval", "human_acceptance"),
        );
      }
    },
  );
}

function runCli(args) {
  return new Promise((resolveResult) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { encoding: "utf8" },
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

test("quote-intake passes without modifying the Build Pack", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  const before = await hashBuildPack(buildPackDirectory);

  const firstResult = await validateBuildPack(buildPackDirectory);
  const secondResult = await validateBuildPack(buildPackDirectory);

  assert.deepEqual(firstResult, { status: "PASS", exitCode: 0, issues: [] });
  assert.deepEqual(secondResult, firstResult);
  assert.equal(await hashBuildPack(buildPackDirectory), before);
});

test("missing quest.yaml is an operational error", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await unlink(join(buildPackDirectory, "quest.yaml"));

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "OPERATIONAL_ERROR");
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.issues, [
    {
      file: "quest.yaml",
      path: "<root>",
      reason: "file does not exist",
    },
  ]);
});

test("invalid YAML is an operational error", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await writeFile(join(buildPackDirectory, "quest.yaml"), "version: [\n", "utf8");

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "OPERATIONAL_ERROR");
  assert.equal(result.exitCode, 2);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].file, "quest.yaml");
  assert.equal(result.issues[0].path, "line 2, column 1");
  assert.equal(result.issues[0].reason, "YAML BAD_INDENT");
});

for (const [name, tag] of [
  ["dangerous", "!!js/function"],
  ["unknown", "!unknown"],
]) {
  test(`${name} YAML tags are stable operational errors`, async () => {
    const buildPackDirectory = await copyBuildPackWithTaggedTitle(tag);
    const before = await hashBuildPack(buildPackDirectory);

    const validationResult = await validateBuildPack(buildPackDirectory);

    assert.deepEqual(validationResult, {
      status: "OPERATIONAL_ERROR",
      exitCode: 2,
      issues: [
        {
          file: "quest.yaml",
          path: "line 3, column 8",
          reason: "YAML TAG_RESOLVE_FAILED",
        },
      ],
    });

    const firstCliResult = await runCli(["validate", buildPackDirectory]);
    const secondCliResult = await runCli(["validate", buildPackDirectory]);

    assert.equal(firstCliResult.exitCode, 2);
    assert.equal(firstCliResult.stdout, "");
    assert.match(
      firstCliResult.stderr,
      /^OPERATIONAL_ERROR\r?\nquest\.yaml line 3, column 8 YAML TAG_RESOLVE_FAILED\r?\n$/,
    );
    assert.deepEqual(secondCliResult, firstCliResult);
    assert.doesNotMatch(firstCliResult.stderr, /node:\d+|YAMLWarning|^\s*at /m);
    assert.doesNotMatch(firstCliResult.stderr, /[A-Za-z]:[\\/]/);
    assert.equal(await hashBuildPack(buildPackDirectory), before);
  });
}

test("a missing required field is a validation failure", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await updateDocument(buildPackDirectory, "quest.yaml", (quest) => {
    delete quest.goal;
  });

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "VALIDATION_FAIL");
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "quest.yaml" &&
        issue.path === "/goal" &&
        issue.reason.includes("required"),
    ),
  );
});

test("an unknown field reports its exact path", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await updateDocument(buildPackDirectory, "quest.yaml", (quest) => {
    quest.unexpectedField = true;
  });

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "VALIDATION_FAIL");
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "quest.yaml" &&
        issue.path === "/unexpectedField" &&
        issue.reason.includes("additional properties"),
    ),
  );
});

test("an unsupported profile is a validation failure", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await updateDocument(buildPackDirectory, "quest.yaml", (quest) => {
    quest.profile = "enterprise";
  });

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "VALIDATION_FAIL");
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "quest.yaml" &&
        issue.path === "/profile" &&
        issue.reason.includes("allowed values"),
    ),
  );
});

test("an isolation policy flag requires isolation evidence for any profile", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await updateDocument(buildPackDirectory, "policy.yaml", (policy) => {
    policy.isolationEvidenceRequired = true;
  });

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "VALIDATION_FAIL");
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "artifact-contract.yaml" &&
        issue.path === "/required" &&
        issue.reason.includes("isolation_evidence"),
    ),
  );
});

test("a personal profile may require isolation evidence when the artifact is present", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await updateDocument(buildPackDirectory, "policy.yaml", (policy) => {
    policy.isolationEvidenceRequired = true;
  });
  await updateDocument(
    buildPackDirectory,
    "artifact-contract.yaml",
    (artifactContract) => {
      artifactContract.required.push(
        requiredArtifact("isolation-proof", "isolation_evidence"),
      );
    },
  );

  const result = await validateBuildPack(buildPackDirectory);

  assert.deepEqual(result, { status: "PASS", exitCode: 0, issues: [] });
});

test("a complete controlled Build Pack passes without evidence files", async () => {
  const before = await hashBuildPack(controlledBuildPack);

  const validationResult = await validateBuildPack(controlledBuildPack);
  const cliResult = await runCli(["validate", controlledBuildPack]);

  assert.deepEqual(validationResult, {
    status: "PASS",
    exitCode: 0,
    issues: [],
  });
  assert.equal(cliResult.exitCode, 0);
  assert.equal(cliResult.stdout.trim(), "PASS");
  assert.equal(cliResult.stderr, "");
  assert.equal(await hashBuildPack(controlledBuildPack), before);
});

test("a controlled profile requires the isolation policy flag", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await makeControlledPack(buildPackDirectory, {
    isolationEvidenceRequired: false,
  });

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "VALIDATION_FAIL");
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "policy.yaml" &&
        issue.path === "/isolationEvidenceRequired" &&
        issue.reason.includes("must be true"),
    ),
  );
});

test("a controlled profile requires isolation evidence", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await makeControlledPack(buildPackDirectory, {
    includeIsolationEvidence: false,
  });

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "VALIDATION_FAIL");
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "artifact-contract.yaml" &&
        issue.path === "/required" &&
        issue.reason.includes("isolation_evidence"),
    ),
  );
});

test("a controlled profile requires human acceptance", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await makeControlledPack(buildPackDirectory, {
    includeHumanAcceptance: false,
  });

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "VALIDATION_FAIL");
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "artifact-contract.yaml" &&
        issue.path === "/required" &&
        issue.reason.includes("human_acceptance"),
    ),
  );
});

test("identical in-scope and out-of-scope entries conflict", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  let duplicatedScope;
  await updateDocument(buildPackDirectory, "quest.yaml", (quest) => {
    duplicatedScope = quest.scope.in[0];
    quest.scope.out.push(duplicatedScope);
  });

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "VALIDATION_FAIL");
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "quest.yaml" &&
        issue.path === "/scope/in/0" &&
        issue.reason.includes(JSON.stringify(duplicatedScope)),
    ),
  );
});

test("identical allowed and forbidden paths conflict", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  let duplicatedPath;
  await updateDocument(buildPackDirectory, "policy.yaml", (policy) => {
    duplicatedPath = policy.allowedPaths[0];
    policy.forbiddenPaths.push(duplicatedPath);
  });

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "VALIDATION_FAIL");
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "policy.yaml" &&
        issue.path === "/allowedPaths/0" &&
        issue.reason.includes(JSON.stringify(duplicatedPath)),
    ),
  );
});

test("acceptance case ids must be unique", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  let duplicateIndex;
  let duplicatedId;
  await updateDocument(buildPackDirectory, "acceptance.yaml", (acceptance) => {
    duplicateIndex = acceptance.cases.length;
    const duplicate = structuredClone(acceptance.cases[0]);
    duplicatedId = duplicate.id;
    duplicate.expected = { duplicate: true };
    acceptance.cases.push(duplicate);
  });

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "VALIDATION_FAIL");
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "acceptance.yaml" &&
        issue.path === `/cases/${duplicateIndex}/id` &&
        issue.reason.includes(JSON.stringify(duplicatedId)),
    ),
  );
});

test("artifact ids must be unique", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  let duplicateIndex;
  let duplicatedId;
  await updateDocument(
    buildPackDirectory,
    "artifact-contract.yaml",
    (artifactContract) => {
      duplicateIndex = artifactContract.required.length;
      const duplicate = structuredClone(artifactContract.required[0]);
      duplicatedId = duplicate.id;
      duplicate.description = "A different artifact with the same id";
      artifactContract.required.push(duplicate);
    },
  );

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "VALIDATION_FAIL");
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "artifact-contract.yaml" &&
        issue.path === `/required/${duplicateIndex}/id` &&
        issue.reason.includes(JSON.stringify(duplicatedId)),
    ),
  );
});

test("Build Pack files cannot be symbolic links outside the directory", async (t) => {
  const buildPackDirectory = await copyExampleBuildPack();
  const outsideQuest = join(dirname(buildPackDirectory), "outside-quest.yaml");
  const questPath = join(buildPackDirectory, "quest.yaml");
  await copyFile(questPath, outsideQuest);
  await unlink(questPath);

  try {
    await symlink(outsideQuest, questPath, "file");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      t.skip("Windows did not permit creating the test symbolic link");
      return;
    }
    throw error;
  }

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "OPERATIONAL_ERROR");
  assert.equal(result.exitCode, 2);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "quest.yaml" &&
        issue.path === "<root>" &&
        issue.reason === "symbolic links are not allowed",
    ),
  );
});

test("policy.allowedCommands is treated as data and never executed", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  const marker = join(dirname(buildPackDirectory), "allowed-command-ran.txt");
  await updateDocument(buildPackDirectory, "policy.yaml", (policy) => {
    policy.allowedCommands = [
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      )}`,
    ];
  });

  const result = await validateBuildPack(buildPackDirectory);

  assert.equal(result.status, "PASS");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("the dist CLI validates a Windows path containing spaces", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  const before = await hashBuildPack(buildPackDirectory);

  const firstResult = await runCli(["validate", buildPackDirectory]);
  const secondResult = await runCli(["validate", buildPackDirectory]);

  assert.equal(firstResult.exitCode, 0);
  assert.equal(firstResult.stdout.trim(), "PASS");
  assert.equal(firstResult.stderr, "");
  assert.deepEqual(secondResult, firstResult);
  assert.equal(await hashBuildPack(buildPackDirectory), before);
});

test("the dist CLI returns exit code 1 with field-level validation details", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await updateDocument(buildPackDirectory, "quest.yaml", (quest) => {
    quest.profile = "enterprise";
  });

  const result = await runCli(["validate", buildPackDirectory]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^VALIDATION_FAIL\r?\n/);
  assert.match(result.stderr, /quest\.yaml \/profile .*allowed values/);
});

test("the dist CLI canonically escapes control characters in validation issue paths", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await updateDocument(buildPackDirectory, "quest.yaml", (quest) => {
    quest[hostileControlKey] = true;
  });

  const first = await runCli(["validate", buildPackDirectory]);
  const second = await runCli(["validate", buildPackDirectory]);
  const normalizedStderr = first.stderr.replaceAll("\r\n", "\n");

  assert.equal(first.exitCode, 1);
  assert.equal(first.stdout, "");
  assert.equal(
    normalizedStderr,
    "VALIDATION_FAIL\nquest.yaml " +
      escapedHostileControlPath +
      " must NOT have additional properties\n",
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

test("the dist CLI returns exit code 2 for a missing fixed file", async () => {
  const buildPackDirectory = await copyExampleBuildPack();
  await unlink(join(buildPackDirectory, "quest.yaml"));

  const result = await runCli(["validate", buildPackDirectory]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^OPERATIONAL_ERROR\r?\n/);
  assert.match(result.stderr, /quest\.yaml <root> file does not exist/);
});

test("the dist CLI returns usage for a missing directory argument", async () => {
  const result = await runCli([]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^OPERATIONAL_ERROR\r?\n/);
  assert.match(result.stderr, /usage: safe-build validate <directory>/);
});

test("the dist CLI rejects an empty directory argument", async () => {
  const result = await runCli(["validate", ""]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^OPERATIONAL_ERROR\r?\n/);
  assert.match(result.stderr, /usage: safe-build validate <directory>/);
  assert.doesNotMatch(result.stderr, /quest\.yaml/);
});
