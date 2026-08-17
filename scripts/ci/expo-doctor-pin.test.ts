import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const exampleRoot = join(repositoryRoot, "example/expo")
const wrapperCall = "bun ../../scripts/ci/check-expo-health.ts"

test("Expo checks stay exact, locked, local, and wrapped in every workflow", async () => {
  const workflowDirectory = join(repositoryRoot, ".github/workflows")
  const workflowNames = (await readdir(workflowDirectory))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
  const [manifestSource, lockfile, wrapper, ...workflows] = await Promise.all([
    readFile(join(exampleRoot, "package.json"), "utf8"),
    readFile(join(exampleRoot, "bun.lock"), "utf8"),
    readFile(join(repositoryRoot, "scripts/ci/check-expo-health.ts"), "utf8"),
    ...workflowNames.map(async (name) => ({
      name,
      source: await readFile(join(workflowDirectory, name), "utf8"),
    })),
  ])
  const manifest = JSON.parse(manifestSource) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const expected = {
    expo: ["dependencies", "~57.0.14", "57.0.14"],
    "expo-constants": ["dependencies", "~57.0.12", "57.0.12"],
    "expo-router": ["dependencies", "~57.0.14", "57.0.14"],
    "expo-doctor": ["devDependencies", "1.20.2", "1.20.2"],
  } as const
  const workspaceSection = lockfile.slice(0, lockfile.indexOf('\n  "packages":'))

  for (const [name, [section, declared, resolved]] of Object.entries(expected)) {
    expect(manifest[section]?.[name]).toBe(declared)
    expect(workspaceSection.match(new RegExp(`"${name}":\\s*"([^"]+)"`))?.[1]).toBe(declared)
    expect(lockfile.match(new RegExp(`^\\s*"${name}":\\s*\\["${name}@([^"]+)"`, "m"))?.[1]).toBe(
      resolved,
    )
  }

  const workflowCalls: Array<{ name: string; call: string }> = []
  for (const workflow of workflows) {
    expect(workflow.source).not.toMatch(/\b(?:bunx|npx|npm\s+(?:exec|x))\b/)
    expect(workflow.source).not.toContain("expo-doctor")
    expect(workflow.source).not.toContain("expo install --check")
    for (const line of workflow.source.split("\n")) {
      if (line.includes(wrapperCall)) workflowCalls.push({ name: workflow.name, call: line.trim() })
    }
    if (workflow.source.includes(wrapperCall)) {
      expect(workflow.source).toMatch(
        new RegExp(
          `- run: ${escapeRegExp(wrapperCall)} (?:ci|release)\\n {8}working-directory: example/expo`,
        ),
      )
      const job = workflow.source.slice(
        workflow.source.lastIndexOf("\n  expo-example:", workflow.source.indexOf(wrapperCall)),
        workflow.source.indexOf(wrapperCall),
      )
      expect(job).toContain("timeout-minutes: 45")
    }
  }

  expect(workflowCalls).toEqual([
    { name: "ci.yml", call: `- run: ${wrapperCall} ci` },
    { name: "release.yml", call: `- run: ${wrapperCall} release` },
  ])
  expect(wrapper).toContain('runLocal("expo-doctor", [], { EXPO_OFFLINE: "1" })')
  expect(wrapper).toContain("EXPO_OFFLINE: undefined")
  expect(wrapper).toContain("productionChildTimeoutMs")
  expect(wrapper).toContain('join(process.cwd(), "node_modules/.bin", binary)')
  expect(wrapper).not.toMatch(/\b(?:bunx|npx|npm\s+(?:exec|x))\b/)
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
