// What: bundle the M4 JavaScript Action and copy its runtime schemas.
// Run: npm run build:action
// Needs: npm ci completed; no network or credentials; writes only dist/ and action-dist/.

import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const sourcePath = join(projectRoot, "dist", "github-action.js");
const outputDirectory = join(projectRoot, "action-dist");
const schemaSourceDirectory = join(projectRoot, "schemas");
const compiledSchemaDirectory = join(projectRoot, "dist", "schemas");
const schemaOutputDirectory = join(outputDirectory, "schemas");
const nccCli = join(
  projectRoot,
  "node_modules",
  "@vercel",
  "ncc",
  "dist",
  "ncc",
  "cli.js",
);
const schemaFilenames = [
  "acceptance.schema.json",
  "artifact-contract.schema.json",
  "evidence-manifest.schema.json",
  "policy.schema.json",
  "quest.schema.json",
];
const execFileAsync = promisify(execFile);

async function normalizedSchema(filename) {
  return (await readFile(join(schemaSourceDirectory, filename), "utf8")).replace(
    /\r\n?/gu,
    "\n",
  );
}

await mkdir(compiledSchemaDirectory, { recursive: true });
for (const filename of schemaFilenames) {
  await writeFile(
    join(compiledSchemaDirectory, filename),
    await normalizedSchema(filename),
    "utf8",
  );
}

await execFileAsync(
  process.execPath,
  [
    nccCli,
    "build",
    sourcePath,
    "--out",
    outputDirectory,
    "--minify",
    "--no-cache",
    "--license",
    "licenses.txt",
  ],
  { cwd: projectRoot },
);

const generatedEntries = (await readdir(outputDirectory)).sort();
const relocatedSchemas = generatedEntries.filter((entry) =>
  /^[0-9a-f]{20}\.json$/u.test(entry),
);
const expectedRootEntries = [
  relocatedSchemas[0],
  "index.js",
  "licenses.txt",
  "package.json",
  "schemas",
].sort();
if (
  relocatedSchemas.length !== 1 ||
  JSON.stringify(generatedEntries) !== JSON.stringify(expectedRootEntries)
) {
  throw new Error(`ACTION_BUNDLE_ROOT_UNEXPECTED ${generatedEntries.join(",")}`);
}

await mkdir(schemaOutputDirectory, { recursive: true });
for (const filename of schemaFilenames) {
  await writeFile(
    join(schemaOutputDirectory, filename),
    await normalizedSchema(filename),
    "utf8",
  );
}

const rootEntries = (await readdir(outputDirectory)).sort();
if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRootEntries)) {
  throw new Error(`ACTION_BUNDLE_ROOT_UNEXPECTED ${rootEntries.join(",")}`);
}
const schemaEntries = (await readdir(schemaOutputDirectory)).sort();
if (JSON.stringify(schemaEntries) !== JSON.stringify(schemaFilenames)) {
  throw new Error(`ACTION_BUNDLE_SCHEMAS_UNEXPECTED ${schemaEntries.join(",")}`);
}
