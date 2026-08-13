import { readdirSync, readFileSync } from "node:fs"
import { extname, resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Resolve hook for the `expo-turbo/expo` packaging smoke test.
 *
 * The built entrypoint imports `react`, `react-native`, and `expo-router`.
 * None are installed at the repository root, and React Native has no Node
 * build at all, so those three specifiers — and only those three — resolve to
 * a generated stub. Everything else, including all of the package's own
 * modules, resolves and executes normally.
 *
 * The stub's exports are read out of the artifact rather than hand-listed, so
 * adding an import of, say, one more React hook cannot turn this gate into a
 * failure that is about the stub instead of about the package.
 */
const STUBBED = ["react", "react-native", "expo-router"]
const DIST = fileURLToPath(new URL("../dist", import.meta.url))

function artifactFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolvePath(directory, entry.name)
    if (entry.isDirectory()) files.push(...artifactFiles(path))
    else if (entry.isFile() && extname(path) === ".js") files.push(path)
  }
  return files
}

function importedNames(specifier) {
  const pattern = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*"${specifier}"`, "g")
  const names = new Set()
  for (const file of artifactFiles(DIST)) {
    const source = readFileSync(file, "utf8")
    for (const [, clause] of source.matchAll(pattern)) {
      for (const binding of clause.split(",")) {
        const name = binding.split(/\s+as\s+/)[0]?.trim()
        if (name) names.add(name)
      }
    }
  }
  return [...names]
}

function stubUrl(specifier) {
  const exports = importedNames(specifier).map((name) => {
    // Anything a component tree calls during render has to return something
    // inert; hooks that must yield a value get the narrowest one that works.
    if (name === "useMemo") return `export const ${name} = (factory) => factory()`
    if (name === "useCallback") return `export const ${name} = (value) => value`
    if (name === "useRef") return `export const ${name} = () => ({ current: undefined })`
    if (name === "useState") return `export const ${name} = () => [undefined, () => {}]`
    if (name === "createContext") return `export const ${name} = () => ({ Provider: () => null })`
    if (name === "Component") return `export const ${name} = class {}`
    if (name === "Fragment") return `export const ${name} = Symbol.for("react.fragment")`
    if (name === "AccessibilityInfo")
      return `export const ${name} = { announceForAccessibility() {} }`
    if (name === "I18nManager") return `export const ${name} = { isRTL: false }`
    if (name === "Linking") return `export const ${name} = { openURL: async () => undefined }`
    return `export const ${name} = () => undefined`
  })
  exports.push("export default {}")
  return `data:text/javascript,${encodeURIComponent(exports.join("\n"))}`
}

const stubs = new Map(STUBBED.map((specifier) => [specifier, stubUrl(specifier)]))

export function resolve(specifier, context, next) {
  const stub = stubs.get(specifier)
  if (stub) return { shortCircuit: true, url: stub }
  return next(specifier, context)
}
