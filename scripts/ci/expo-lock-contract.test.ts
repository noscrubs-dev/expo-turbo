import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

test("the Expo lock contains only the recorded patch graph", async () => {
  const [lockSource, contractSource, manifestSource] = await Promise.all([
    readFile(join(repositoryRoot, "example/expo/bun.lock"), "utf8"),
    readFile(join(repositoryRoot, "scripts/ci/expo-lock-contract.json"), "utf8"),
    readFile(join(repositoryRoot, "example/expo/package.json"), "utf8"),
  ])
  const lock = parseBunLock(lockSource)
  const contract = JSON.parse(contractSource) as {
    baseline: string
    bunVersion: string
    unchangedPackagesSha256: string
    allowedPackageChanges: Record<string, [string | null, string | null]>
  }
  const manifest = JSON.parse(manifestSource) as { overrides?: Record<string, string> }

  expect(contract).toMatchObject({ baseline: "61bc0e8^", bunVersion: "1.3.14" })
  expect(manifest.overrides).toEqual({ "expo-constants": "$expo-constants" })

  for (const [key, [, expected]] of Object.entries(contract.allowedPackageChanges)) {
    expect(lock.packages[key]?.[0] ?? null).toBe(expected)
  }

  const allowed = new Set(Object.keys(contract.allowedPackageChanges))
  const unchangedPackages = Object.keys(lock.packages)
    .filter((key) => !allowed.has(key))
    .sort()
    .map((key) => [key, lock.packages[key]])
  expect(createHash("sha256").update(JSON.stringify(unchangedPackages)).digest("hex")).toBe(
    contract.unchangedPackagesSha256,
  )

  const constants = Object.entries(lock.packages)
    .filter(([, value]) => value[0].startsWith("expo-constants@"))
    .map(([key, value]) => [key, value[0]])
  expect(constants).toEqual([["expo-constants", "expo-constants@57.0.12"]])
})

type BunLock = { packages: Record<string, [string, ...unknown[]]> }

function parseBunLock(source: string): BunLock {
  let result = ""
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      result += character
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      result += character
      continue
    }
    if (character === ",") {
      let next = index + 1
      while (/\s/.test(source[next] ?? "")) next += 1
      if (source[next] === "}" || source[next] === "]") continue
    }
    result += character
  }
  return JSON.parse(result) as BunLock
}
