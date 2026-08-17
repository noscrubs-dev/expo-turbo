import { afterEach, describe, expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const pruneScript = join(scriptDirectory, "prune-maestro-tests.sh")
const laneScript = join(scriptDirectory, "run-android-maestro.sh")
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe.serial("Maestro test retention", () => {
  test("keeps the 12 newest timestamp directories out of 20", async () => {
    const root = await fixtureRoot()
    await addTimestamps(root, 20)

    const result = await runPruner(pruneScript, root, "12", "apply")

    expect(result).toMatchObject({ status: 0, timedOut: false })
    expect(await timestampEntries(root)).toEqual(timestampNames(20).slice(8))
    expect(candidateLines(result.stdout)).toEqual(
      timestampNames(20)
        .slice(0, 8)
        .map((name) => `Prune Maestro test directory: ${root}/${name}`),
    )
  })

  test("keeps all 12 when the root already meets retention", async () => {
    const root = await fixtureRoot()
    await addTimestamps(root, 12)

    const result = await runPruner(pruneScript, root, "12", "apply")

    expect(result.status).toBe(0)
    expect(candidateLines(result.stdout)).toEqual([])
    expect(await timestampEntries(root)).toEqual(timestampNames(12))
  })

  test("treats a missing safe root as success", async () => {
    const parent = await mkdtemp(join(tmpdir(), "maestro-prune-missing-"))
    fixtures.push(parent)
    const root = join(parent, ".maestro", "tests")

    const result = await runPruner(pruneScript, root, "12", "apply")

    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("fails closed for unsafe arguments and roots", async () => {
    const root = await fixtureRoot()
    const cases: Array<[string, string, string]> = [
      [root, "0", "apply"],
      [root, "-1", "apply"],
      [root, "twelve", "apply"],
      [root, "12", "APPLY"],
      ["relative/.maestro/tests", "12", "apply"],
      [join(dirname(root), "not-tests"), "12", "apply"],
      [join(dirname(dirname(root)), "other", "tests"), "12", "apply"],
    ]

    for (const [candidate, count, mode] of cases) {
      const result = await runPruner(pruneScript, candidate, count, mode)
      expect(result.status).not.toBe(0)
    }

    expect(await timestampEntries(root)).toEqual([])
  })

  test("rejects noncanonical decimal keep counts without deletion", async () => {
    for (const count of ["012", "00", "08", "09"]) {
      const root = await fixtureRoot()
      await addTimestamps(root, 13)
      const before = await timestampEntries(root)
      const result = await runPruner(pruneScript, root, count, "apply")
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("keep_count must be a positive integer")
      expect(await timestampEntries(root)).toEqual(before)
    }
  })

  test("rejects a root file and a root symlink", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "maestro-prune-roots-"))
    fixtures.push(fixture)
    const realRoot = join(fixture, "real", ".maestro", "tests")
    const linkedRoot = join(fixture, "linked", ".maestro", "tests")
    const fileRoot = join(fixture, "file", ".maestro", "tests")
    await mkdir(realRoot, { recursive: true })
    await mkdir(dirname(linkedRoot), { recursive: true })
    await symlink(realRoot, linkedRoot)
    await mkdir(dirname(fileRoot), { recursive: true })
    await writeFile(fileRoot, "not a directory")

    expect((await runPruner(pruneScript, linkedRoot, "12", "apply")).status).not.toBe(0)
    expect((await runPruner(pruneScript, fileRoot, "12", "apply")).status).not.toBe(0)
  })

  test("skips files, nonmatching directories, and symlinks inside the root", async () => {
    const root = await fixtureRoot()
    await addTimestamps(root, 20)
    const outside = join(dirname(dirname(root)), "outside")
    await mkdir(outside)
    await writeFile(join(outside, "sentinel"), "safe")
    await writeFile(join(root, "1999-01-01_000000"), "hostile file")
    await mkdir(join(root, "not-a-maestro-run"))
    await mkdir(join(root, "2026-8-01_000000"))
    await symlink(outside, join(root, "1998-01-01_000000"))

    const result = await runPruner(pruneScript, root, "12", "apply")

    expect(result.status).toBe(0)
    expect((await lstat(join(root, "1998-01-01_000000"))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(root, "1999-01-01_000000"), "utf8")).toBe("hostile file")
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("safe")
    expect(await readdir(root)).toContain("not-a-maestro-run")
    expect(await readdir(root)).toContain("2026-8-01_000000")
  })

  test("rejects newline, carriage return, spaces, and symlinks as run names", async () => {
    const root = await fixtureRoot()
    await addTimestamps(root, 12)
    const hostileNames = [
      "0000-00-00_000000\n2026-08-01_999999",
      "0000-00-00_000000\r2026-08-01_999998",
      "2026-08-01_999997 extra",
    ]
    for (const name of hostileNames) await mkdir(join(root, name))
    const outside = join(dirname(dirname(root)), "newline-outside")
    await mkdir(outside)
    await writeFile(join(outside, "sentinel"), "safe")
    await symlink(outside, join(root, "0000-00-00_000000"))

    const result = await runPruner(pruneScript, root, "12", "apply")

    expect(result.status).toBe(0)
    expect(
      (await readdir(root)).filter((name) => timestampNames(12).includes(name)).sort(),
    ).toEqual(timestampNames(12))
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("safe")
    for (const name of hostileNames) expect(await readdir(root)).toContain(name)
  })

  test("dry-run prints the same candidates as apply and changes nothing", async () => {
    const dryRoot = await fixtureRoot()
    const applyRoot = await fixtureRoot()
    await addTimestamps(dryRoot, 20)
    await addTimestamps(applyRoot, 20)

    const dry = await runPruner(pruneScript, dryRoot, "12", "dry-run")
    const applied = await runPruner(pruneScript, applyRoot, "12", "apply")

    expect(dry.status).toBe(0)
    expect(candidateNames(dry.stdout)).toEqual(candidateNames(applied.stdout))
    expect(await timestampEntries(dryRoot)).toHaveLength(20)
    expect(await timestampEntries(applyRoot)).toHaveLength(12)
  })

  test("bounds a 200-directory root to 12 without hanging", async () => {
    const root = await fixtureRoot()
    await addTimestamps(root, 200)

    const result = await runPruner(pruneScript, root, "12", "apply")

    expect(result.timedOut).toBe(false)
    expect(result.status).toBe(0)
    expect(candidateLines(result.stdout)).toHaveLength(188)
    expect(await timestampEntries(root)).toHaveLength(12)
  })

  test("warns above 512 MB without deleting beyond retention", async () => {
    const root = await fixtureRoot()
    await addTimestamps(root, 13)
    const tools = await mkdtemp(join(tmpdir(), "maestro-prune-tools-"))
    fixtures.push(tools)
    const fakeDu = join(tools, "du")
    await writeFile(fakeDu, '#!/bin/sh\nprintf "524289\\t%s\\n" "$2"\n')
    await chmod(fakeDu, 0o755)

    const result = await runPruner(pruneScript, root, "12", "apply", {
      ...process.env,
      PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    })

    expect(result.status).toBe(0)
    expect(await timestampEntries(root)).toHaveLength(12)
    expect(result.stderr).toContain("exceeds 512 MB")
    expect(result.stderr).toContain("No extra entries were deleted")
  })

  test("keeps completed pruning when du fails or returns unparseable output", async () => {
    for (const script of ["#!/bin/sh\nexit 7\n", "#!/bin/sh\nprintf 'unknown\\n'\n"]) {
      const root = await fixtureRoot()
      await addTimestamps(root, 13)
      const tools = await mkdtemp(join(tmpdir(), "maestro-prune-tools-"))
      fixtures.push(tools)
      await writeFile(join(tools, "du"), script)
      await chmod(join(tools, "du"), 0o755)

      const result = await runPruner(pruneScript, root, "12", "apply", {
        ...process.env,
        PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      })

      expect(result.status).toBe(0)
      expect(await timestampEntries(root)).toHaveLength(12)
      expect(result.stderr).toContain("could not measure Maestro test storage after retention")
    }
  })

  test("the exact-name guard is load-bearing", async () => {
    const root = await fixtureRoot()
    await addTimestamps(root, 13)
    await mkdir(join(root, "0000-not-a-timestamp"))
    const source = await readFile(pruneScript, "utf8")
    const mutation = source
      .replace(
        '  if is_timestamp_name "$name"; then\n    timestamp_names+=("$name")\n  fi',
        '  timestamp_names+=("$name")',
      )
      .replace(
        '    if ! is_timestamp_name "$name" ||\n      [ ! -d "$candidate" ]',
        '    if [ ! -d "$candidate" ]',
      )
    expect(mutation).not.toBe(source)
    const mutatedScript = await writeMutation(mutation)

    const result = await runPruner(mutatedScript, root, "12", "apply")

    expect(result.status).toBe(0)
    expect(await readdir(root)).not.toContain("0000-not-a-timestamp")
  })

  test("the symlink guards are load-bearing", async () => {
    const root = await fixtureRoot()
    await addTimestamps(root, 12)
    const outside = join(dirname(dirname(root)), "outside-symlink-target")
    await mkdir(outside)
    await writeFile(join(outside, "sentinel"), "safe")
    await symlink(outside, join(root, "1998-01-01_000000"))
    const source = await readFile(pruneScript, "utf8")
    const mutation = source
      .replace('  [ ! -L "$entry" ] || continue\n', "")
      .replace(' || [ -L "$candidate" ]; then', "; then")
    expect(mutation).not.toBe(source)
    const mutatedScript = await writeMutation(mutation)

    const result = await runPruner(mutatedScript, root, "12", "apply")

    expect(result.status).toBe(0)
    expect(await readdir(root)).not.toContain("1998-01-01_000000")
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("safe")
  })
})

describe.serial("Android lane retention wiring", () => {
  test("runs the fixed retention command after the version guard and before lane output", async () => {
    const lane = await readFile(laneScript, "utf8")
    assertLaneRetention(lane)
  })

  test("rejects changes to the fixed count, mode, path resolution, and order", async () => {
    const lane = await readFile(laneScript, "utf8")
    const mutations = [
      lane.replace('"$maestro_tests_root" 12 apply', '"$maestro_tests_root" 20 apply'),
      lane.replace('"$maestro_tests_root" 12 apply', '"$maestro_tests_root" 12 dry-run'),
      lane.replace("$XDG_STATE_HOME/maestro/tests", "$XDG_STATE_HOME/.maestro/tests"),
      lane.replace("$HOME/.maestro/tests", "$HOME/maestro/tests"),
      lane.replace(
        '"$script_dir/prune-maestro-tests.sh" "$maestro_tests_root" 12 apply',
        'bun install --frozen-lockfile\n"$script_dir/prune-maestro-tests.sh" "$maestro_tests_root" 12 apply',
      ),
    ]

    for (const mutation of mutations) {
      expect(() => assertLaneRetention(mutation)).toThrow()
    }
  })
})

function assertLaneRetention(lane: string): void {
  const guard = 'maestro_version="$("$script_dir/check-maestro-version.sh")"'
  const prune = '"$script_dir/prune-maestro-tests.sh" "$maestro_tests_root" 12 apply'
  const install = "bun install --frozen-lockfile"
  expect(lane).toContain('maestro_tests_root="$XDG_STATE_HOME/maestro/tests"')
  expect(lane).toContain('maestro_tests_root="$HOME/.maestro/tests"')
  expect(lane.match(/prune-maestro-tests\.sh/g)).toHaveLength(1)
  expect(lane.indexOf(guard)).toBeGreaterThan(-1)
  expect(lane.indexOf(prune)).toBeGreaterThan(lane.indexOf(guard))
  expect(lane.indexOf(prune)).toBeLessThan(lane.indexOf(install))
  expect(lane.slice(lane.indexOf(guard), lane.indexOf(prune))).not.toMatch(/mkdir|:\s*>/)
}

async function fixtureRoot(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "maestro-prune-"))
  fixtures.push(fixture)
  const root = join(fixture, ".maestro", "tests")
  await mkdir(root, { recursive: true })
  return root
}

function timestampNames(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `2026-08-01_${String(index + 1).padStart(6, "0")}`,
  )
}

async function addTimestamps(root: string, count: number): Promise<void> {
  for (const name of timestampNames(count)) await mkdir(join(root, name))
}

async function timestampEntries(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(name)).sort()
}

function candidateLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("Prune Maestro test directory: "))
}

function candidateNames(stdout: string): string[] {
  return candidateLines(stdout).map((line) => line.slice(line.lastIndexOf("/") + 1))
}

async function writeMutation(source: string): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "maestro-prune-script-"))
  fixtures.push(fixture)
  const path = join(fixture, "prune-maestro-tests.sh")
  await writeFile(path, source)
  await chmod(path, 0o755)
  return path
}

async function runPruner(
  script: string,
  root: string,
  count: string,
  mode: string,
  env?: Record<string, string | undefined>,
) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "maestro-prune-output-"))
  fixtures.push(outputDirectory)
  const stdoutPath = join(outputDirectory, "stdout.txt")
  const stderrPath = join(outputDirectory, "stderr.txt")
  const process = Bun.spawn(["/bin/bash", script, root, count, mode], {
    env: env ?? globalThis.process.env,
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    process.kill("SIGKILL")
  }, 15_000)
  const status = await process.exited
  clearTimeout(timer)
  return {
    status,
    stdout: await readFile(stdoutPath, "utf8"),
    stderr: await readFile(stderrPath, "utf8"),
    timedOut,
  }
}
