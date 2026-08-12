import assert from "node:assert/strict"
import { register } from "node:module"

/**
 * Smoke-imports the built `expo-turbo/expo` entrypoint so the packaging gate
 * covers the subpath, not just the dependency-free ones. Its three platform
 * imports are stubbed by the registered loader; the package's own modules run
 * for real, so a broken export map, a bad relative specifier, or a module-scope
 * failure inside the artifact fails this check.
 */
register("./expo-entrypoint-loader.mjs", import.meta.url)

const expo = await import(new URL("../dist/expo/index.js", import.meta.url).href)

for (const name of ["ExpoTurboApp", "ExpoTurboErrorSurface", "ExpoTurboLoadingSurface"]) {
  assert.equal(typeof expo[name], "function", `expo-turbo/expo must export ${name}`)
}
