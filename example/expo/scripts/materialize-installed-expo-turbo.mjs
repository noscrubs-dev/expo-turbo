import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installedRoot = resolve(exampleRoot, "node_modules/expo-turbo");
const snapshotRoot = resolve(exampleRoot, "node_modules/.expo-turbo-independent");

const manifestBytes = await readFile(resolve(installedRoot, "package.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const targets = collectExportTargets(manifest.exports);
const files = ["./package.json", ...targets.filter((target) => target !== "./package.json")];

await rm(snapshotRoot, { recursive: true, force: true });
for (const target of files) {
  if (!target.startsWith("./") || target.split(/[\\/]/).some((part) => part === "..")) {
    throw new Error(`Cannot materialize unsafe export target ${JSON.stringify(target)}`);
  }
  const source = resolve(installedRoot, target);
  const destination = resolve(snapshotRoot, target);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

const provenance = {
  schemaVersion: 1,
  source: "node_modules/expo-turbo",
  files: Object.fromEntries(
    await Promise.all(
      files.sort().map(async (target) => [
        target,
        createHash("sha256").update(await readFile(resolve(snapshotRoot, target))).digest("hex"),
      ]),
    ),
  ),
};
await writeFile(
  resolve(snapshotRoot, ".expo-turbo-snapshot.json"),
  `${JSON.stringify(provenance, null, 2)}\n`,
);

function collectExportTargets(value) {
  if (value === null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectExportTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectExportTargets);
  throw new Error("Cannot materialize a malformed exports graph");
}
