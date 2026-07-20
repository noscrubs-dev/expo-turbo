import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, extname, isAbsolute, relative, resolve } from "node:path"
import * as ts from "typescript"

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
] as const

const forbiddenPackages = [
  "@hotwired/turbo",
  "@acme",
  "@noscrubs",
  "@noscrubs-dev",
  "@expo-shared",
  "@tanstack/react-query",
  "expo-router",
  "react-query",
] as const

export type BoundaryViolation = Readonly<{
  file: string
  reason: string
  specifier: string
}>

type PackageManifest = Readonly<Record<string, unknown>>

export async function scanSourceBoundaries(
  packageRoot = process.cwd(),
): Promise<BoundaryViolation[]> {
  const sourceRoot = resolve(packageRoot, "src")
  const violations = await scanManifest(packageRoot)

  for (const file of await filesIn(sourceRoot, isSourceFile)) {
    violations.push(
      ...scanModuleSpecifiers(file, await readFile(file, "utf8"), sourceRoot, packageRoot),
    )
  }

  return violations
}

export async function scanArtifactBoundaries(
  packageRoot = process.cwd(),
): Promise<BoundaryViolation[]> {
  const artifactRoot = resolve(packageRoot, "dist")
  const sourceRoot = resolve(packageRoot, "src")
  const violations = await scanManifest(packageRoot)

  await assertDirectory(
    artifactRoot,
    "Built artifacts are missing; run bun run build before artifact:boundaries:check",
  )

  for (const file of await filesIn(artifactRoot, isArtifactFile)) {
    const content = await readFile(file, "utf8")

    if (file.endsWith(".map")) {
      violations.push(...scanSourceMap(file, content, sourceRoot, packageRoot))
    } else {
      violations.push(...scanModuleSpecifiers(file, content, artifactRoot, packageRoot))
    }
  }

  return violations
}

export function assertNoBoundaryViolations(violations: readonly BoundaryViolation[]): void {
  if (violations.length === 0) return

  const details = violations.map(
    ({ file, reason, specifier }) => `- ${file}: ${reason} (${specifier})`,
  )
  throw new Error(`Package boundary check failed:\n${details.join("\n")}`)
}

async function scanManifest(packageRoot: string): Promise<BoundaryViolation[]> {
  const manifestPath = resolve(packageRoot, "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown
  if (!isRecord(manifest)) throw new Error("package.json must contain an object")

  const violations: BoundaryViolation[] = []
  for (const section of dependencySections) {
    const names = dependencyNames(manifest, section)
    for (const name of names) {
      const reason = forbiddenDependencyReason(name)
      if (reason) {
        violations.push({
          file: "package.json",
          reason: `${reason} in ${section}`,
          specifier: name,
        })
      }
    }
  }

  return violations
}

function dependencyNames(
  manifest: PackageManifest,
  section: (typeof dependencySections)[number],
): string[] {
  const value = manifest[section]
  if (value === undefined) return []
  if (Array.isArray(value)) return value.filter((name): name is string => typeof name === "string")
  if (isRecord(value)) return Object.keys(value)

  throw new Error(`package.json ${section} must be an object or array`)
}

function scanSourceMap(
  file: string,
  content: string,
  sourceRoot: string,
  packageRoot: string,
): BoundaryViolation[] {
  let sourceMap: unknown
  try {
    sourceMap = JSON.parse(content)
  } catch {
    throw new Error(`Invalid source map: ${displayPath(packageRoot, file)}`)
  }

  if (!isRecord(sourceMap) || !Array.isArray(sourceMap.sourcesContent)) return []

  const sources = Array.isArray(sourceMap.sources) ? sourceMap.sources : []
  return sourceMap.sourcesContent.flatMap((sourceContent, index) => {
    if (typeof sourceContent !== "string") return []

    const source = sources[index]
    const sourceFile = typeof source === "string" ? resolve(dirname(file), source) : file
    return scanModuleSpecifiers(sourceFile, sourceContent, sourceRoot, packageRoot)
  })
}

function scanModuleSpecifiers(
  file: string,
  content: string,
  allowedRoot: string,
  packageRoot: string,
): BoundaryViolation[] {
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
  const violations: BoundaryViolation[] = []

  const inspect = (specifier: string) => {
    const reason = boundaryReason(specifier, file, allowedRoot)
    if (reason) violations.push({ file: displayPath(packageRoot, file), reason, specifier })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        inspect(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression
      if (expression && ts.isStringLiteral(expression)) inspect(expression.text)
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      inspect(node.argument.literal.text)
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments
      if (!argument || !ts.isStringLiteral(argument)) {
        ts.forEachChild(node, visit)
        return
      }

      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        inspect(argument.text)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

function boundaryReason(
  specifier: string,
  importer: string,
  allowedRoot: string,
): string | undefined {
  const forbiddenReason = forbiddenDependencyReason(specifier)
  if (forbiddenReason) return forbiddenReason
  if (specifier.startsWith("@/") || specifier.startsWith("~/"))
    return "app alias imports are not allowed"
  if (isAbsolute(specifier) || specifier.startsWith("file:"))
    return "absolute filesystem and file URL imports are not allowed"
  if (!specifier.startsWith(".")) return undefined

  const resolved = resolve(dirname(importer), specifier)
  const pathFromRoot = relative(allowedRoot, resolved)
  if (pathFromRoot === ".." || pathFromRoot.startsWith("../") || isAbsolute(pathFromRoot)) {
    return "relative import resolves outside the package source root"
  }
}

function forbiddenDependencyReason(specifier: string): string | undefined {
  if (
    specifier === "@tanstack/react-query" ||
    specifier.startsWith("@tanstack/react-query/") ||
    specifier.startsWith("@tanstack/react-query-")
  ) {
    return "forbidden dependency @tanstack/react-query"
  }

  const forbidden = forbiddenPackages.find(
    (packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
  )
  return forbidden ? `forbidden dependency ${forbidden}` : undefined
}

async function filesIn(directory: string, matches: (file: string) => boolean): Promise<string[]> {
  await assertDirectory(directory, `Missing directory: ${directory}`)
  const files: string[] = []

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await filesIn(file, matches)))
    } else if (entry.isFile() && matches(file)) {
      files.push(file)
    }
  }

  return files.sort()
}

async function assertDirectory(directory: string, message: string): Promise<void> {
  try {
    if ((await stat(directory)).isDirectory()) return
  } catch {
    // Use the same actionable error for a missing directory and a non-directory path.
  }

  throw new Error(message)
}

function isSourceFile(file: string): boolean {
  return [".ts", ".tsx", ".mts", ".cts"].includes(extname(file))
}

function isArtifactFile(file: string): boolean {
  return file.endsWith(".d.ts") || [".js", ".map"].includes(extname(file))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function displayPath(packageRoot: string, file: string): string {
  return relative(packageRoot, file) || "."
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "source"
  const violations =
    mode === "source"
      ? await scanSourceBoundaries()
      : mode === "artifact"
        ? await scanArtifactBoundaries()
        : (() => {
            throw new Error("Usage: bun scripts/check-package-boundaries.ts [source|artifact]")
          })()

  assertNoBoundaryViolations(violations)
}
