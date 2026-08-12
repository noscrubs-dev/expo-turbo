import assert from "node:assert/strict"
import { register } from "node:module"

/**
 * Smoke-imports the built `expo-turbo/expo` entrypoint so the packaging gate
 * covers the subpath, not just the dependency-free ones. Its three platform
 * imports are stubbed by the registered loader; the package's own modules run
 * for real, so a bad relative specifier or a module-scope failure inside the
 * artifact fails this check.
 *
 * The import is by package subpath, not by file path, so it resolves through
 * the `exports` map exactly the way a consumer's would. Importing
 * `../dist/expo/index.js` directly would keep passing while the export map
 * pointed at a file that does not exist.
 */
register("./expo-entrypoint-loader.mjs", import.meta.url)

const expo = await import("expo-turbo/expo")

for (const name of ["ExpoTurboApp", "ExpoTurboErrorSurface", "ExpoTurboLoadingSurface"]) {
  assert.equal(typeof expo[name], "function", `expo-turbo/expo must export ${name}`)
}
