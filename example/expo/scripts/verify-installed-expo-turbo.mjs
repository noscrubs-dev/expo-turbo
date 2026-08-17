import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(scriptDirectory, "../../..");
const defaultExampleRoot = resolve(scriptDirectory, "..");
const defaultInstalledRoot = resolve(defaultExampleRoot, "node_modules/.expo-turbo-independent");

export async function verifyInstalledPackage({
  repositoryRoot = defaultRepositoryRoot,
  installedRoot = defaultInstalledRoot,
} = {}) {
  const rootPackageRoot = resolve(repositoryRoot);
  const installedPackageRoot = resolve(installedRoot);
  const rootManifestPath = resolve(rootPackageRoot, "package.json");
  const installedManifestPath = resolve(installedPackageRoot, "package.json");

  let rootManifest;
  let installedManifest;
  try {
    rootManifest = await readManifest(rootManifestPath, "repository-root");
    installedManifest = await readManifest(installedManifestPath, "installed");
  } catch (error) {
    throw new Error(`${error.message}\nRoot: ${rootManifestPath}\nInstalled: ${installedManifestPath}`);
  }

  const difference = firstDifference(rootManifest.exports, installedManifest.exports, "exports");
  if (difference) {
    throw new Error(
      `Installed expo-turbo exports differ: ${difference}\nRoot: ${rootManifestPath}\nInstalled: ${installedManifestPath}`,
    );
  }

  await compareIndependentFiles(rootManifestPath, installedManifestPath, "package manifest");

  const targets = collectExportTargets(rootManifest.exports);
  if (installedPackageRoot === defaultInstalledRoot) {
    await verifySnapshotProvenance(installedPackageRoot, targets);
  }
  for (const target of targets) {
    const rootTargetPath = resolve(rootPackageRoot, target);
    const installedTargetPath = resolve(installedPackageRoot, target);
    try {
      await validateTarget(rootPackageRoot, target, "repository-root");
      await validateTarget(installedPackageRoot, target, "installed");
    } catch (error) {
      throw new Error(`${error.message}\nRoot: ${rootTargetPath}\nInstalled: ${installedTargetPath}`);
    }
    if (target !== "./package.json") {
      await compareIndependentFiles(rootTargetPath, installedTargetPath, `export ${JSON.stringify(target)}`);
    }
  }

  return { rootManifestPath, installedManifestPath, targets };
}

async function verifySnapshotProvenance(installedRoot, targets) {
  const provenancePath = resolve(installedRoot, ".expo-turbo-snapshot.json");
  let provenance;
  try {
    provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read installed snapshot provenance: ${provenancePath}\n${error.message}`);
  }
  const files = ["./package.json", ...targets.filter((target) => target !== "./package.json")].sort();
  if (
    !isObject(provenance) ||
    provenance.schemaVersion !== 1 ||
    provenance.source !== "node_modules/expo-turbo" ||
    !isObject(provenance.files) ||
    firstDifference(files, Object.keys(provenance.files), "provenance.files")
  ) {
    throw new Error(`Installed snapshot provenance contract failed: ${provenancePath}`);
  }
  for (const target of files) {
    const digest = createHash("sha256")
      .update(await readFile(resolve(installedRoot, target)))
      .digest("hex");
    if (provenance.files[target] !== digest) {
      throw new Error(`Installed snapshot provenance digest failed for ${JSON.stringify(target)}.`);
    }
  }
}

async function compareIndependentFiles(rootPath, installedPath, description) {
  const [rootStat, installedStat, rootBytes, installedBytes] = await Promise.all([
    stat(rootPath),
    stat(installedPath),
    readFile(rootPath),
    readFile(installedPath),
  ]);
  if (rootStat.dev === installedStat.dev && rootStat.ino === installedStat.ino) {
    throw new Error(
      `Installed expo-turbo ${description} shares an inode with the root build.\nRoot: ${rootPath}\nInstalled: ${installedPath}`,
    );
  }
  if (!rootBytes.equals(installedBytes)) {
    throw new Error(
      `Installed expo-turbo ${description} bytes differ.\nRoot: ${rootPath}\nInstalled: ${installedPath}`,
    );
  }
}

async function readManifest(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${label} package manifest: ${path}\n${error.message}`);
  }

  try {
    const manifest = JSON.parse(source);
    if (!("exports" in manifest)) throw new Error('missing required "exports" field');
    return manifest;
  } catch (error) {
    throw new Error(`Malformed ${label} package manifest: ${path}\n${error.message}`);
  }
}

function firstDifference(rootValue, installedValue, path) {
  if (rootValue === null || installedValue === null) {
    return rootValue === installedValue
      ? undefined
      : `${path} changed from ${JSON.stringify(rootValue)} to ${JSON.stringify(installedValue)}`;
  }
  if (Array.isArray(rootValue) || Array.isArray(installedValue)) {
    if (!Array.isArray(rootValue) || !Array.isArray(installedValue)) {
      return `${path} changed type from ${valueType(rootValue)} to ${valueType(installedValue)}`;
    }
    if (rootValue.length !== installedValue.length) {
      return `${path} array length changed from ${rootValue.length} to ${installedValue.length}`;
    }
    for (let index = 0; index < rootValue.length; index += 1) {
      const difference = firstDifference(rootValue[index], installedValue[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return undefined;
  }
  if (isObject(rootValue) || isObject(installedValue)) {
    if (!isObject(rootValue) || !isObject(installedValue)) {
      return `${path} changed type from ${valueType(rootValue)} to ${valueType(installedValue)}`;
    }
    const rootKeys = Object.keys(rootValue);
    const installedKeys = Object.keys(installedValue);
    const rootSet = new Set(rootKeys);
    const installedSet = new Set(installedKeys);
    const missing = rootKeys.find((key) => !installedSet.has(key));
    if (missing !== undefined) return `${path}.${missing} is missing from the installed package`;
    const added = installedKeys.find((key) => !rootSet.has(key));
    if (added !== undefined) return `${path}.${added} was added to the installed package`;
    for (let index = 0; index < rootKeys.length; index += 1) {
      if (rootKeys[index] !== installedKeys[index]) {
        return `${path} key order changed at ${JSON.stringify(rootKeys[index])}`;
      }
      const key = rootKeys[index];
      const difference = firstDifference(rootValue[key], installedValue[key], `${path}.${key}`);
      if (difference) return difference;
    }
    return undefined;
  }
  if (typeof rootValue !== typeof installedValue) {
    return `${path} changed type from ${valueType(rootValue)} to ${valueType(installedValue)}`;
  }
  if (rootValue !== installedValue) {
    return `${path} changed from ${JSON.stringify(rootValue)} to ${JSON.stringify(installedValue)}`;
  }
  return undefined;
}

function collectExportTargets(exportsValue) {
  const targets = [];

  function visit(value, path, root = false) {
    if (value === null) return;
    if (typeof value === "string") {
      targets.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (isObject(value)) {
      const entries = Object.entries(value);
      const subpathKeys = entries.filter(([key]) => key.startsWith("."));
      if (subpathKeys.length > 0 && (!root || subpathKeys.length !== entries.length)) {
        throw new Error(
          `Malformed exports graph at ${path}: subpath keys cannot be mixed with or nested inside conditions`,
        );
      }
      for (const [key, entry] of entries) {
        if (!key.startsWith(".") && (/^(0|[1-9][0-9]*)$/.test(key) || key.length === 0)) {
          throw new Error(`Malformed exports graph at ${path}: invalid condition ${JSON.stringify(key)}`);
        }
        visit(entry, `${path}.${key}`);
      }
      return;
    }
    throw new Error(
      `Malformed exports graph at ${path}: expected an object, array, string, or null; got ${valueType(value)}`,
    );
  }

  visit(exportsValue, "exports", true);
  return [...new Set(targets)];
}

async function validateTarget(packageRoot, target, label) {
  if (
    !target.startsWith("./") ||
    isAbsolute(target) ||
    target.split(/[\\/]/).some((part) => part === "..")
  ) {
    throw new Error(`Unsafe ${label} export target ${JSON.stringify(target)} in ${packageRoot}`);
  }

  const targetPath = resolve(packageRoot, target);
  const canonicalRoot = await realpath(packageRoot);
  let canonicalTarget;
  let targetStat;
  try {
    [canonicalTarget, targetStat] = await Promise.all([realpath(targetPath), stat(targetPath)]);
  } catch (error) {
    throw new Error(
      `Missing ${label} export target ${JSON.stringify(target)}: ${targetPath}\n${error.message}`,
    );
  }
  if (!isContained(canonicalRoot, canonicalTarget)) {
    throw new Error(
      `Unsafe ${label} export target ${JSON.stringify(target)} escapes its package root.\nPackage: ${packageRoot}\nTarget: ${targetPath}`,
    );
  }
  if (!targetStat.isFile()) {
    throw new Error(
      `Invalid ${label} export target ${JSON.stringify(target)} is not a regular file: ${targetPath}`,
    );
  }
}

function isContained(root, target) {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

async function main() {
  try {
    const result = await verifyInstalledPackage(cliOptions(process.argv.slice(2)));
    console.log(
      `Installed expo-turbo exports match the root build (${result.targets.length} file targets).`,
    );
  } catch (error) {
    console.error(error.message);
    console.error(
      "Repair: cd ../.. && bun run build && cd example/expo, then run bun install --frozen-lockfile to create a new independent snapshot",
    );
    process.exitCode = 1;
  }
}

function cliOptions(arguments_) {
  if (arguments_.length === 0) return {};
  if (arguments_.length !== 4 || arguments_[0] !== "--repository-root" || arguments_[2] !== "--installed-root") {
    throw new Error("Usage: verify-installed-expo-turbo.mjs --repository-root PATH --installed-root PATH");
  }
  return { repositoryRoot: arguments_[1], installedRoot: arguments_[3] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
