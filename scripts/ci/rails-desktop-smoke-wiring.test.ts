import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const liveSmokeDirectory = join(repositoryRoot, "example/expo/src")
const workflowPath = join(repositoryRoot, ".github/workflows/ci.yml")

async function liveSmokeFiles(directory = liveSmokeDirectory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return liveSmokeFiles(path)
      return /^demo-live-.*\.(?:rails|redis)-smoke\.test\.[tj]sx?$/.test(entry.name) ? [path] : []
    }),
  )

  return files.flat().sort()
}

function desktopSmokeJob(workflow: string): string {
  const start = workflow.indexOf("  rails-action-cable-smoke:")
  if (start === -1) throw new Error("Rails desktop smoke job is missing")

  const nextJob = workflow.slice(start + 1).search(/^ {2}[a-z0-9_-]+:/m)
  return nextJob === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + nextJob)
}

test("Rails desktop smoke runs every live smoke file in isolated Bun workers", async () => {
  const [workflow, files] = await Promise.all([readFile(workflowPath, "utf8"), liveSmokeFiles()])
  const smokeJob = desktopSmokeJob(workflow)

  expect(files).not.toEqual([])
  expect(smokeJob).toMatch(/bun test --isolate\s+\\/)
  for (const file of files) {
    expect(smokeJob).toContain(`src/${file.slice(liveSmokeDirectory.length + 1)}`)
  }
})
