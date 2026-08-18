import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const liveSmokeDirectory = join(repositoryRoot, "example/expo/src")
const workflowPath = join(repositoryRoot, ".github/workflows/ci.yml")
const bunTestCommand = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|()<>$`\\]*\s+)*bun\s+test(?:\s|$)/
const bunTestCommandWithArguments =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|()<>$`\\]*\s+)*bun\s+test(?:\s+(.*))?$/

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

function runScripts(job: string): string[] {
  return Array.from(
    job.matchAll(/^ {8}run: \|\n((?:(?:^ {10,}.*|^)\n)*)/gm),
    ([, script]) => script ?? "",
  )
}

function shellCommands(script: string): string[] {
  const commands: string[] = []
  let command = ""

  for (const line of script.split("\n")) {
    const trimmed = line.trim()
    if (!command && (!trimmed || trimmed.startsWith("#"))) continue

    const continues = /\\$/.test(trimmed)
    command += `${trimmed.replace(/\\$/, "")} `
    if (!continues) {
      commands.push(command.trim())
      command = ""
    }
  }

  if (command) throw new Error("Rails desktop smoke command has an unfinished continuation")
  return commands
}

function smokeTestCommand(workflow: string): string {
  const commands = runScripts(desktopSmokeJob(workflow)).flatMap(shellCommands)
  const candidates = commands.filter((command) => bunTestCommand.test(command))
  const candidate = candidates[0]

  if (candidates.length !== 1 || !candidate) {
    throw new Error(
      `Rails desktop smoke must have exactly one bun test command, found ${candidates.length}`,
    )
  }

  return candidate
}

function smokeTestFiles(workflow: string): string[] {
  const command = smokeTestCommand(workflow)
  const match = command.match(bunTestCommandWithArguments)
  if (!match) throw new Error("Rails desktop smoke bun test command is malformed")

  const argumentsAfterTest = (match[1] ?? "").trim().split(/\s+/).filter(Boolean)
  if (argumentsAfterTest[0] !== "--isolate") {
    throw new Error("Rails desktop smoke must put --isolate directly after bun test")
  }

  return argumentsAfterTest.slice(1)
}

function expectSmokeFiles(workflow: string, files: string[]): void {
  const expected = files.map((file) => `src/${file.slice(liveSmokeDirectory.length + 1)}`).sort()
  expect(smokeTestFiles(workflow).sort()).toEqual(expected)
}

function firstSmokeFile(files: string[]): string {
  const file = files[0]
  if (!file) throw new Error("Rails desktop smoke file list is empty")
  return `src/${file.slice(liveSmokeDirectory.length + 1)}`
}

test("Rails desktop smoke runs every live smoke file in isolated Bun workers", async () => {
  const [workflow, files] = await Promise.all([readFile(workflowPath, "utf8"), liveSmokeFiles()])

  expect(files).not.toEqual([])
  expectSmokeFiles(workflow, files)
})

test("Rails desktop smoke wiring rejects missing isolation and incomplete file lists", async () => {
  const [workflow, files] = await Promise.all([readFile(workflowPath, "utf8"), liveSmokeFiles()])
  const file = firstSmokeFile(files)

  expect(() =>
    expectSmokeFiles(workflow.replace("bun test --isolate", "bun test"), files),
  ).toThrow()
  expect(() =>
    expectSmokeFiles(workflow.replace(`                  ${file} \\\n`, ""), files),
  ).toThrow()
})

test("Rails desktop smoke wiring requires Bun to be the executed command", async () => {
  const [workflow, files] = await Promise.all([readFile(workflowPath, "utf8"), liveSmokeFiles()])
  const command = "EXPO_TURBO_DEMO_ORIGIN=http://127.0.0.1:3001 bun test --isolate"

  expectSmokeFiles(workflow, files)
  expect(() => expectSmokeFiles(workflow.replace(command, `echo ${command}`), files)).toThrow()
  expect(() => expectSmokeFiles(workflow.replace(command, `printf ${command}`), files)).toThrow()
})

test("Rails desktop smoke wiring ignores file paths outside the Bun command", async () => {
  const [workflow, files] = await Promise.all([readFile(workflowPath, "utf8"), liveSmokeFiles()])
  const file = firstSmokeFile(files)
  const pathInStepName = workflow.replace(
    "name: Smoke Rails desktop integration",
    `name: Smoke ${file}`,
  )
  const missingCommandFile = pathInStepName.replace(`                  ${file} \\\n`, "")

  expect(missingCommandFile).toContain(file)
  expect(() => expectSmokeFiles(missingCommandFile, files)).toThrow()
})
