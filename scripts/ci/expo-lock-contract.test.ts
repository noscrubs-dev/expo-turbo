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
    allowedPackageValueSha256: Record<string, string>
    allowedPackageChanges: Record<string, [string | null, string | null]>
  }
  const manifest = JSON.parse(manifestSource) as { overrides?: Record<string, string> }

  expect(contract).toMatchObject({ baseline: "61bc0e8^", bunVersion: "1.3.14" })
  expect(manifest.overrides).toEqual({ "expo-constants": "$expo-constants" })

  verifyLock(lock, contract)

  const constants = Object.entries(lock.packages)
    .filter(([, value]) => value[0].startsWith("expo-constants@"))
    .map(([key, value]) => [key, value[0]])
  expect(constants).toEqual([["expo-constants", "expo-constants@57.0.12"]])

  const mutationKeys = Object.keys(contract.allowedPackageChanges)
  const firstAllowedKey = mutationKeys[0]
  if (firstAllowedKey === undefined) throw new Error("lock contract has no allowed package changes")
  for (const mutation of [
    (packages: BunLock["packages"]) => {
      packageTuple(packages, "expo")[3] = "sha512-mutated"
    },
    (packages: BunLock["packages"]) => {
      metadata(packages, "@expo/cli").dependencies.expo = "~0.0.0"
    },
    (packages: BunLock["packages"]) => {
      metadata(packages, "expo-router").peerDependencies["react-native"] = "0.0.0"
    },
    (packages: BunLock["packages"]) => {
      metadata(packages, "expo").bin.expo = "bin/changed"
    },
    (packages: BunLock["packages"]) => {
      metadata(packages, "expo").nested = { changed: true }
    },
    (packages: BunLock["packages"]) => {
      delete packages[firstAllowedKey]
    },
    (packages: BunLock["packages"]) => {
      packages["stale-allowed-key"] = ["expo@57.0.14"]
    },
  ]) {
    const mutated = structuredClone(lock)
    mutation(mutated.packages)
    expect(() => verifyLock(mutated, contract)).toThrow()
  }
})

type BunLock = { packages: Record<string, [string, ...unknown[]]> }
type PackageMetadata = Record<string, unknown> & {
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  bin: Record<string, string>
}
type LockContract = {
  unchangedPackagesSha256: string
  allowedPackageValueSha256: Record<string, string>
  allowedPackageChanges: Record<string, [string | null, string | null]>
}

function verifyLock(lock: BunLock, contract: LockContract): void {
  expect(Object.keys(contract.allowedPackageValueSha256).sort()).toEqual(
    Object.keys(contract.allowedPackageChanges).sort(),
  )
  for (const [key, [, expected]] of Object.entries(contract.allowedPackageChanges)) {
    expect(lock.packages[key]?.[0] ?? null).toBe(expected)
    const expectedDigest = contract.allowedPackageValueSha256[key]
    if (expectedDigest === undefined) throw new Error(`missing digest for allowed package ${key}`)
    expect(digest(lock.packages[key])).toBe(expectedDigest)
  }

  const allowed = new Set(Object.keys(contract.allowedPackageChanges))
  const unchangedPackages = Object.keys(lock.packages)
    .filter((key) => !allowed.has(key))
    .sort()
    .map((key) => [key, lock.packages[key]])
  expect(digest(unchangedPackages)).toBe(contract.unchangedPackagesSha256)
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex")
}

function metadata(packages: BunLock["packages"], key: string): PackageMetadata {
  return packageTuple(packages, key)[2] as PackageMetadata
}

function packageTuple(packages: BunLock["packages"], key: string): [string, ...unknown[]] {
  const value = packages[key]
  if (value === undefined) throw new Error(`missing package ${key}`)
  return value
}

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
