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
  /**
   * A named export per entrypoint. Asserting only "it imported as an object"
   * passes for a blanked module — every ESM namespace is an object, empty or
   * not — which is how a stripped `expo-turbo/adapters` would slip through.
   *
   * `./testing` is deliberately empty until the first executable fixtures land,
   * so it is asserted as empty rather than skipped: if it grows exports, this
   * list has to be updated on purpose.
   */
  const expectedExports = {
    ".": ["EXPO_TURBO_RUNTIME_VERSION", "EXPO_TURBO_STATUS", "createDefaultFetchAdapter"],
    "./adapters": ["createDefaultFetchAdapter", "defineStyleAdapter", "isTurboMultipartBody"],
    "./core": ["DocumentSession", "parseExpoTurboDocument", "StateError"],
    "./expo": ["ExpoTurboApp", "ExpoTurboErrorSurface", "ExpoTurboLoadingSurface"],
    "./expo-router": ["createExpoRouterAdapters", "useExpoRouterAdapters"],
    "./react": ["ExpoTurbo", "ExpoTurboProvider", "ExpoTurboRoot", "useExpoTurboDisposable"],
    "./registry": ["attr", "createRegistry", "defineComponentModule"],
    "./testing": [],
  }

  const declared = subpaths
    .map(([subpath]) => subpath)
    .filter((subpath) => subpath !== "./package.json")
  const unchecked = declared.filter((subpath) => !(subpath in expectedExports))
  assert.deepEqual(
    unchecked,
    [],
    `these entrypoints ship with nothing asserted about them: ${unchecked.join(", ")}`,
  )
  const checks = declared.map((subpath) => [
    subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`,
    expectedExports[subpath],
  ])

  writeFileSync(
    join(extracted, "archive-runner.mjs"),
    [
      'import assert from "node:assert/strict"',
      'import { register } from "node:module"',
      'register("./scripts/expo-entrypoint-loader.mjs", import.meta.url)',
      `const checks = ${JSON.stringify(checks)}`,
      "for (const [specifier, names] of checks) {",
      "  const module = await import(specifier)",
      "  assert.ok(module && typeof module === 'object', `${specifier} did not load`)",
      "  for (const name of names) {",
      "    assert.ok(",
      "      module[name] !== undefined,",
      "      `${specifier} is missing its ${name} export in the packed archive`,",
      "    )",
      "  }",
      "  if (names.length === 0) {",
      "    assert.deepEqual(",
      "      Object.keys(module).filter((key) => key !== 'default'),",
      "      [],",
      "      `${specifier} is documented as empty but ships exports`,",
      "    )",
      "  }",
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
