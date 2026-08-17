import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const exampleCheckChain = [
  "bun run verify:installed-package",
  "bun run capabilities:check",
  "bun run lint",
  "bun run typecheck",
  "bun run test",
  "bun run export:all",
]

function expectExampleCheckChain(check: string): void {
  expect(check).toBe(exampleCheckChain.join(" && "))
}

test("the example gate verifies the installed build first and never uses the lint cache", async () => {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "example/expo/package.json"), "utf8"),
  )

  expect(manifest.scripts.lint).toBe("expo lint --no-cache")
  expectExampleCheckChain(manifest.scripts.check)
  expect(manifest.scripts["verify:installed-package"]).toBe(
    "node scripts/verify-installed-expo-turbo.mjs",
  )
})

test("the example check cannot drop or reorder the capability verification", () => {
  expect(() =>
    expectExampleCheckChain(
      exampleCheckChain.filter((step) => step !== "bun run capabilities:check").join(" && "),
    ),
  ).toThrow()
  expect(() =>
    expectExampleCheckChain(
      [exampleCheckChain[1], exampleCheckChain[0], ...exampleCheckChain.slice(2)].join(" && "),
    ),
  ).toThrow()
})

test("CI and release build before the frozen example install and check", async () => {
  for (const workflowName of ["ci.yml", "release.yml"]) {
    const workflow = await readFile(join(repositoryRoot, ".github/workflows", workflowName), "utf8")
    const expoJob = workflow.slice(
      workflow.indexOf("  expo-example:"),
      workflow.indexOf("\n  rails-example:"),
    )
    const build = expoJob.indexOf("- run: bun run build")
    const frozenInstall = expoJob.indexOf(
      "- run: bun install --frozen-lockfile\n        working-directory: example/expo",
    )
    const check = expoJob.indexOf("- run: bun run check\n        working-directory: example/expo")

    expect(build).toBeGreaterThan(-1)
    expect(frozenInstall).toBeGreaterThan(build)
    expect(check).toBeGreaterThan(frozenInstall)
  }
})
