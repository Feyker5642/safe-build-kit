import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const destination = resolve(projectRoot, "dist", "schemas");
const schemaFiles = [
  "quest.schema.json",
  "policy.schema.json",
  "acceptance.schema.json",
  "artifact-contract.schema.json",
  "evidence-manifest.schema.json",
];

await mkdir(destination, { recursive: true });

for (const schemaFile of schemaFiles) {
  await copyFile(
    resolve(projectRoot, "schemas", schemaFile),
    resolve(destination, schemaFile),
  );
}
