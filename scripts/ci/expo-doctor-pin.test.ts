import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const exampleRoot = join(repositoryRoot, "example/expo")
const workflowPaths = [
  join(repositoryRoot, ".github/workflows/ci.yml"),
  join(repositoryRoot, ".github/workflows/release.yml"),
]

test("Expo Doctor stays exact, locked, and local in CI", async () => {
  const [manifestSource, lockfile, ...workflows] = await Promise.all([
    readFile(join(exampleRoot, "package.json"), "utf8"),
    readFile(join(exampleRoot, "bun.lock"), "utf8"),
    ...workflowPaths.map((path) => readFile(path, "utf8")),
  ])
  const manifest = JSON.parse(manifestSource) as {
    devDependencies?: Record<string, string>
  }
  const version = manifest.devDependencies?.["expo-doctor"]

  expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  if (version === undefined) throw new Error("expo-doctor must be an exact devDependency")

  const workspaceSection = lockfile.slice(0, lockfile.indexOf('\n  "packages":'))
  const workspaceVersion = workspaceSection.match(/"expo-doctor":\s*"([^"]+)"/)?.[1]
  const resolvedVersion = lockfile.match(/^\s*"expo-doctor":\s*\["expo-doctor@([^"]+)"/m)?.[1]

  expect(workspaceVersion).toBe(version)
  expect(resolvedVersion).toBe(version)

  for (const workflow of workflows) {
    const doctorLines = workflow.split("\n").filter((line) => line.includes("expo-doctor"))

    expect(doctorLines).toEqual(["      - run: ./node_modules/.bin/expo-doctor"])
    expect(workflow).toContain(
      "      - run: ./node_modules/.bin/expo-doctor\n        working-directory: example/expo",
    )
  }
})
