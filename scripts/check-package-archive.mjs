import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Packs the real tarball, unpacks it, and imports every entrypoint out of the
 * extracted tree through the package `exports` map.
 *
 * Importing the repository's own `dist` proves nothing about what ships: the
 * `files` list decides that, and omitting a directory there leaves `dist`
 * intact locally while the published archive has a dangling export target.
 * Only the extracted archive answers the question consumers care about.
 */
const packageRoot = resolve(fileURLToPath(import.meta.url), "../..")
const workspace = mkdtempSync(join(tmpdir(), "expo-turbo-archive-"))

try {
  // `--filename` and `--destination` are mutually exclusive, so take the
  // default name and find it.
  execFileSync("bun", ["pm", "pack", "--quiet", "--destination", workspace], {
    cwd: packageRoot,
    stdio: ["ignore", "ignore", "inherit"],
  })
  const packed = readdirSync(workspace).filter((entry) => entry.endsWith(".tgz"))
  assert.equal(packed.length, 1, `expected exactly one tarball, got ${packed.join(", ") || "none"}`)
  const tarball = join(workspace, packed[0])

  execFileSync("tar", ["-xzf", tarball, "-C", workspace], {
    stdio: ["ignore", "ignore", "inherit"],
  })
  const extracted = join(workspace, "package")
  assert.ok(existsSync(extracted), "the packed tarball has no package/ root")

  const manifest = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8"))
  const subpaths = Object.entries(manifest.exports ?? {})

  // Every export target must actually be inside the archive.
  const missing = []
  for (const [subpath, target] of subpaths) {
    for (const file of typeof target === "string" ? [target] : Object.values(target)) {
      if (typeof file !== "string" || !file.startsWith("./")) continue
      if (!existsSync(join(extracted, file))) missing.push(`${subpath} -> ${file}`)
    }
  }
  assert.deepEqual(missing, [], `packed archive is missing export targets: ${missing.join(", ")}`)

  // Then actually run them, resolved by subpath through the archive's own
  // exports map, with only the three platform peers stubbed. Runtime
  // dependencies resolve the way a consumer's would: the archive declares them,
  // and this stands in for the install that would provide them.
  symlinkSync(join(packageRoot, "node_modules"), join(extracted, "node_modules"), "dir")

  // The loader resolves `../dist` relative to itself, so it has to sit one
  // directory down inside the extracted package.
  mkdirSync(join(extracted, "scripts"), { recursive: true })
  copyFileSync(
    join(packageRoot, "scripts/expo-entrypoint-loader.mjs"),
    join(extracted, "scripts", "expo-entrypoint-loader.mjs"),
  )
  const importable = subpaths
    .map(([subpath]) => subpath)
    .filter((subpath) => subpath !== "./package.json")
    .map((subpath) => (subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`))

  writeFileSync(
    join(extracted, "archive-runner.mjs"),
    [
      'import assert from "node:assert/strict"',
      'import { register } from "node:module"',
      'register("./scripts/expo-entrypoint-loader.mjs", import.meta.url)',
      `const specifiers = ${JSON.stringify(importable)}`,
      "for (const specifier of specifiers) {",
      "  const module = await import(specifier)",
      "  assert.ok(module && typeof module === 'object', `${specifier} did not load`)",
      "}",
      `const expo = await import(${JSON.stringify(`${manifest.name}/expo`)})`,
      "for (const name of ['ExpoTurboApp', 'ExpoTurboErrorSurface', 'ExpoTurboLoadingSurface']) {",
      "  assert.equal(typeof expo[name], 'function', `${name} is missing from the packed archive`)",
      "}",
      `const root = await import(${JSON.stringify(manifest.name)})`,
      "assert.equal(root.EXPO_TURBO_RUNTIME_VERSION, " +
        JSON.stringify(manifest.version) +
        ", 'packed runtime version mismatch')",
    ].join("\n"),
  )

  execFileSync(process.execPath, [join(extracted, "archive-runner.mjs")], {
    cwd: extracted,
    stdio: ["ignore", "inherit", "inherit"],
  })
} finally {
  rmSync(workspace, { force: true, recursive: true })
}
