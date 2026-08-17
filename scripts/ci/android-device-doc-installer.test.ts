import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const documentation = join(scriptDirectory, "../../docs/android-device-ci.md")
const expectedChecksum = "a4ccab6b604617e7aef6db4f885666056eabe5cfa32befaa3bc994041b8fcbb5"
const installName = `maestro-2.7.0-${expectedChecksum}`
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe("the documented Maestro installer", () => {
  test("is safe to run twice with an exact valid install", async () => {
    const fixture = await createFixture()
    const block = await readInstallerBlock()

    expect((await runInstaller(fixture, block)).status).toBe(0)
    const firstTarget = await readlink(join(fixture, "home/.local/bin/maestro"))

    expect((await runInstaller(fixture, block)).status).toBe(0)
    expect(await readlink(join(fixture, "home/.local/bin/maestro"))).toBe(firstTarget)
    expect(firstTarget).toBe(join(fixture, `home/.local/opt/${installName}/bin/maestro`))
  })

  test("accepts a pinned first line with a trailing update notice", async () => {
    const fixture = await createFixture()
    const result = await runInstaller(fixture, await readInstallerBlock(), {
      maestroBody: "printf '2.7.0\\r\\nMaestro 9.9.9 is available\\n'",
    })

    expect(result).toEqual({ status: 0, stderr: "" })
    expect(await readlink(join(fixture, "home/.local/bin/maestro"))).toContain(installName)
  })

  test("repairs a missing bin directory when it reuses a valid install", async () => {
    const fixture = await createFixture()
    await createExistingInstall(fixture, "printf '2.7.0\\r\\nupdate available\\n'")

    const result = await runInstaller(fixture, await readInstallerBlock())

    expect(result.status).toBe(0)
    expect(await readlink(join(fixture, "home/.local/bin/maestro"))).toBe(
      join(fixture, `home/.local/opt/${installName}/bin/maestro`),
    )
  })

  test("rejects a wrong first-line version before it installs or links", async () => {
    const fixture = await createFixture()
    const result = await runInstaller(fixture, await readInstallerBlock(), {
      maestroBody: "printf '2.6.0\\n2.7.0\\n'",
    })

    expect(result.status).not.toBe(0)
    expect(existsSync(join(fixture, `home/.local/opt/${installName}`))).toBe(false)
    expect(existsSync(join(fixture, "home/.local/bin/maestro"))).toBe(false)
  })

  test("rejects an unexpected archive layout", async () => {
    const fixture = await createFixture()
    const result = await runInstaller(fixture, await readInstallerBlock(), {
      archiveLayout: "unexpected",
    })

    expect(result.status).not.toBe(0)
    expect(existsSync(join(fixture, `home/.local/opt/${installName}`))).toBe(false)
  })

  test("refuses to replace a non-symlink link path", async () => {
    const fixture = await createFixture()
    await mkdir(join(fixture, "home/.local/bin"), { recursive: true })
    await writeFile(join(fixture, "home/.local/bin/maestro"), "do not replace\n")

    const result = await runInstaller(fixture, await readInstallerBlock())

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Refusing to replace non-symlink path")
    expect(await readFile(join(fixture, "home/.local/bin/maestro"), "utf8")).toBe(
      "do not replace\n",
    )
  })

  test("rejects a partial existing install before it changes the symlink", async () => {
    const fixture = await createFixture()
    const currentTarget = join(fixture, "current-maestro")
    await mkdir(join(fixture, `home/.local/opt/${installName}`), { recursive: true })
    await mkdir(join(fixture, "home/.local/bin"), { recursive: true })
    await symlink(currentTarget, join(fixture, "home/.local/bin/maestro"))

    const result = await runInstaller(fixture, await readInstallerBlock())

    expect(result.status).not.toBe(0)
    expect(await readlink(join(fixture, "home/.local/bin/maestro"))).toBe(currentTarget)
  })

  test("rejects a wrong first line from an existing install", async () => {
    const fixture = await createFixture()
    await createExistingInstall(fixture, "printf '2.6.0\\n2.7.0\\n'")

    const result = await runInstaller(fixture, await readInstallerBlock())

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Existing checksum-addressed Maestro install is invalid")
    expect(existsSync(join(fixture, "home/.local/bin/maestro"))).toBe(false)
  })

  test("a wrong checksum cannot install or switch the symlink", async () => {
    const fixture = await createFixture()
    const currentTarget = join(fixture, "current-maestro")
    await mkdir(join(fixture, "home/.local/bin"), { recursive: true })
    await symlink(currentTarget, join(fixture, "home/.local/bin/maestro"))
    const wrongChecksum = "0".repeat(64)
    const block = (await readInstallerBlock()).replace(expectedChecksum, wrongChecksum)

    const result = await runInstaller(fixture, block)

    expect(result.status).not.toBe(0)
    expect(await readlink(join(fixture, "home/.local/bin/maestro"))).toBe(currentTarget)
    expect(existsSync(join(fixture, `home/.local/opt/maestro-2.7.0-${wrongChecksum}`))).toBe(false)
  })
})

async function readInstallerBlock(): Promise<string> {
  const contents = await readFile(documentation, "utf8")
  const section = contents.slice(contents.indexOf("Install exactly the pinned version"))
  const match = section.match(/```sh\n([\s\S]*?)\n```/)

  if (!match?.[1]) {
    throw new Error("The documented Maestro installer block was not found")
  }
  return match[1]
}

async function createFixture(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "expo-turbo-maestro-install-"))
  fixtures.push(fixture)
  const fakeBin = join(fixture, "bin")
  await mkdir(fakeBin)

  await writeExecutable(
    join(fakeBin, "curl"),
    '#!/bin/sh\nwhile [ "$1" != "--output" ]; do shift; done\nprintf archive >"$2"\n',
  )
  await writeExecutable(
    join(fakeBin, "sha256sum"),
    '#!/bin/sh\nread -r checksum archive\ntest "$checksum" = "$EXPECTED_CHECKSUM" || exit 1\ntest -s "$archive"\n',
  )
  await writeExecutable(
    join(fakeBin, "unzip"),
    `#!/bin/sh
while [ "$1" != "-d" ]; do shift; done
destination="$2"
if [ "$FAKE_ARCHIVE_LAYOUT" = "unexpected" ]; then
  mkdir -p "$destination/not-maestro/bin"
else
  mkdir -p "$destination/maestro/bin"
  printf '#!/bin/sh\\n%s\\n' "$FAKE_MAESTRO_BODY" >"$destination/maestro/bin/maestro"
  chmod +x "$destination/maestro/bin/maestro"
fi
`,
  )
  return fixture
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents)
  await chmod(path, 0o755)
}

async function runInstaller(
  fixture: string,
  block: string,
  options: { archiveLayout?: "expected" | "unexpected"; maestroBody?: string } = {},
): Promise<{ status: number; stderr: string }> {
  const stdoutPath = join(fixture, "installer.stdout")
  const stderrPath = join(fixture, "installer.stderr")
  const child = Bun.spawn(["/bin/bash", "-c", block], {
    env: {
      ...process.env,
      EXPECTED_CHECKSUM: expectedChecksum,
      FAKE_ARCHIVE_LAYOUT: options.archiveLayout ?? "expected",
      FAKE_MAESTRO_BODY: options.maestroBody ?? "echo 2.7.0",
      HOME: join(fixture, "home"),
      PATH: `${join(fixture, "bin")}:/usr/bin:/bin`,
    },
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  })
  const status = await child.exited
  return { status, stderr: await readFile(stderrPath, "utf8") }
}

async function createExistingInstall(fixture: string, body: string): Promise<void> {
  const executable = join(fixture, `home/.local/opt/${installName}/bin/maestro`)
  await mkdir(dirname(executable), { recursive: true })
  await writeExecutable(executable, `#!/bin/sh\n${body}\n`)
}
