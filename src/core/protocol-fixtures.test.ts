import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import {
  attributeValue,
  DocumentSession,
  dispatchTurboStreamFragment,
  EXPO_TURBO_PROTOCOL_VERSION,
  isElement,
  type ProtocolElement,
  type ProtocolNode,
  parseExpoTurboDocument,
  parseTurboStreamFragment,
  RAILS_BASELINE_VERSION,
  serializeExpoTurboTree,
  TURBO_BASELINE_VERSION,
  TURBO_RAILS_BASELINE_VERSION,
  TURBO_RAILS_MINIMUM_VERSION,
} from "."

type NormalizedAttribute = readonly [name: string, namespace: string | null, value: string]

type NormalizedNode =
  | {
      readonly cdata: boolean
      readonly kind: "text"
      readonly value: string
    }
  | {
      readonly kind: "comment"
      readonly value: string
    }
  | {
      readonly attributes: readonly NormalizedAttribute[]
      readonly children: readonly NormalizedNode[]
      readonly kind: "element"
      readonly namespace: string | null
      readonly qname: string
    }

interface NormalizedStreamAction {
  action: string
  method?: string
  requestId?: string
  scroll?: string
  target?: string
  targets?: string
  templateTags: readonly string[]
}

interface ProtocolFixture {
  readonly envelope: "document" | "stream-fragment"
  readonly expect:
    | {
        readonly outcome: "accepted"
        readonly normalized?: {
          readonly nodes: readonly NormalizedNode[]
        }
        readonly streamActions?: readonly NormalizedStreamAction[]
      }
    | {
        readonly outcome: "rejected"
      }
  readonly file: string
  readonly id: string
}

interface StreamBehaviorReport {
  readonly action: string
  readonly appliedTargets: number
  readonly matchedTargets: number
  readonly status: "applied" | "canceled" | "error" | "noop"
}

interface StreamBehaviorFixture {
  readonly documentFile: string
  readonly expectedDocumentFile: string
  readonly expectedReports: readonly StreamBehaviorReport[]
  readonly id: string
  readonly identityAssertions: readonly {
    readonly id: string
    readonly outcome: "removed" | "replaced" | "retained"
  }[]
  readonly kind: "stream-mutation"
  readonly streamFile: string
}

interface ProtocolManifest {
  readonly baselines: {
    readonly rails: string
    readonly turbo: string
    readonly turboRails: {
      readonly minimum: string
      readonly target: string
    }
  }
  readonly behaviorFixtures: readonly StreamBehaviorFixture[]
  readonly fixtures: readonly ProtocolFixture[]
  readonly manifestVersion: number
  readonly protocolVersion: string
}

const PROTOCOL_ROOT = new URL("../../protocol/", import.meta.url)
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/"
const FIXTURE_PATH = /^fixtures\/[a-z0-9]+(?:-[a-z0-9]+)*\.xml$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function fixtureUrl(file: string): URL {
  if (!FIXTURE_PATH.test(file)) {
    throw new Error("Protocol fixtures must be local XML files under protocol/fixtures")
  }
  return new URL(file, PROTOCOL_ROOT)
}

function validateManifest(value: unknown): ProtocolManifest {
  if (
    !isRecord(value) ||
    value.manifestVersion !== 1 ||
    typeof value.protocolVersion !== "string"
  ) {
    throw new Error("Protocol compatibility manifest has an invalid version")
  }
  if (
    !isRecord(value.baselines) ||
    !Array.isArray(value.fixtures) ||
    !Array.isArray(value.behaviorFixtures)
  ) {
    throw new Error("Protocol compatibility manifest has invalid baselines or fixtures")
  }

  for (const fixture of value.fixtures) {
    if (!isRecord(fixture) || typeof fixture.id !== "string" || typeof fixture.file !== "string") {
      throw new Error("Protocol compatibility manifest has an invalid fixture")
    }
    if (fixture.envelope !== "document" && fixture.envelope !== "stream-fragment") {
      throw new Error(`Protocol fixture ${fixture.id} has an invalid envelope`)
    }
    if (
      !isRecord(fixture.expect) ||
      !["accepted", "rejected"].includes(String(fixture.expect.outcome))
    ) {
      throw new Error(`Protocol fixture ${fixture.id} has an invalid expected outcome`)
    }
    if (
      fixture.expect.outcome === "accepted" &&
      isRecord(fixture.expect.normalized) === Array.isArray(fixture.expect.streamActions)
    ) {
      throw new Error(`Protocol fixture ${fixture.id} must declare exactly one accepted assertion`)
    }
    fixtureUrl(fixture.file)
  }

  for (const fixture of value.behaviorFixtures) {
    if (
      !isRecord(fixture) ||
      typeof fixture.id !== "string" ||
      fixture.kind !== "stream-mutation" ||
      typeof fixture.documentFile !== "string" ||
      typeof fixture.streamFile !== "string" ||
      typeof fixture.expectedDocumentFile !== "string" ||
      !Array.isArray(fixture.expectedReports) ||
      !Array.isArray(fixture.identityAssertions)
    ) {
      throw new Error("Protocol compatibility manifest has an invalid behavior fixture")
    }
    fixtureUrl(fixture.documentFile)
    fixtureUrl(fixture.streamFile)
    fixtureUrl(fixture.expectedDocumentFile)
    for (const report of fixture.expectedReports) {
      if (
        !isRecord(report) ||
        typeof report.action !== "string" ||
        !["applied", "canceled", "error", "noop"].includes(String(report.status)) ||
        !Number.isInteger(report.matchedTargets) ||
        !Number.isInteger(report.appliedTargets)
      ) {
        throw new Error(`Protocol behavior fixture ${fixture.id} has an invalid report`)
      }
    }
    const identityIds = new Set<string>()
    for (const assertion of fixture.identityAssertions) {
      if (
        !isRecord(assertion) ||
        typeof assertion.id !== "string" ||
        !["removed", "replaced", "retained"].includes(String(assertion.outcome)) ||
        identityIds.has(assertion.id)
      ) {
        throw new Error(`Protocol behavior fixture ${fixture.id} has an invalid identity assertion`)
      }
      identityIds.add(assertion.id)
    }
  }

  return value as unknown as ProtocolManifest
}

async function loadManifest(): Promise<ProtocolManifest> {
  const source = await readFile(new URL("compatibility-manifest.json", PROTOCOL_ROOT), "utf8")
  return validateManifest(JSON.parse(source) as unknown)
}

function compareAttributes(left: NormalizedAttribute, right: NormalizedAttribute): number {
  const leftValues = [left[0], left[1] ?? "", left[2]]
  const rightValues = [right[0], right[1] ?? "", right[2]]
  for (let index = 0; index < leftValues.length; index += 1) {
    const leftValue = leftValues[index] ?? ""
    const rightValue = rightValues[index] ?? ""
    if (leftValue < rightValue) return -1
    if (leftValue > rightValue) return 1
  }
  return 0
}

function normalizeAttributes(element: ProtocolElement): readonly NormalizedAttribute[] {
  return element.attributes
    .filter(
      (attribute) =>
        attribute.name !== "xmlns" &&
        attribute.prefix !== "xmlns" &&
        attribute.namespaceUri !== XMLNS_NAMESPACE,
    )
    .map((attribute) => [attribute.name, attribute.namespaceUri, attribute.value] as const)
    .sort(compareAttributes)
}

function normalizeNode(node: ProtocolNode): NormalizedNode {
  if (node.kind === "document") throw new Error("Protocol fixtures cannot contain nested documents")
  if (node.kind === "text") return { cdata: node.cdata, kind: "text", value: node.value }
  if (node.kind === "comment") return { kind: "comment", value: node.value }

  return {
    attributes: normalizeAttributes(node),
    children: node.children.map(normalizeNode),
    kind: "element",
    namespace: node.namespaceUri,
    qname: node.tagName,
  }
}

function normalizeFixture(xml: string, fixture: ProtocolFixture): readonly NormalizedNode[] {
  const tree =
    fixture.envelope === "document" ? parseExpoTurboDocument(xml) : parseTurboStreamFragment(xml)
  return tree.document.children
    .filter((node) => node.kind !== "text" && node.kind !== "comment")
    .map(normalizeNode)
}

function normalizeStreamActions(xml: string): readonly NormalizedStreamAction[] {
  const tree = parseTurboStreamFragment(xml)
  return tree.document.children.filter(isElement).map((stream) => {
    const template = stream.children.find(
      (node) => isElement(node) && node.tagName === "template",
    ) as ProtocolElement | undefined
    const normalized: NormalizedStreamAction = {
      action: attributeValue(stream, "action") ?? "",
      templateTags: template?.children.filter(isElement).map((node) => node.tagName) ?? [],
    }
    const method = attributeValue(stream, "method")
    const requestId = attributeValue(stream, "request-id")
    const scroll = attributeValue(stream, "scroll")
    const target = attributeValue(stream, "target")
    const targets = attributeValue(stream, "targets")
    if (method !== undefined) normalized.method = method
    if (requestId !== undefined) normalized.requestId = requestId
    if (scroll !== undefined) normalized.scroll = scroll
    if (target !== undefined) normalized.target = target
    if (targets !== undefined) normalized.targets = targets
    return normalized
  })
}

describe("shared protocol fixtures", () => {
  test("pin the shared protocol compatibility baselines", async () => {
    const manifest = await loadManifest()

    expect(manifest.manifestVersion).toBe(1)
    expect(manifest.protocolVersion).toBe(EXPO_TURBO_PROTOCOL_VERSION)
    expect(manifest.baselines.turbo).toBe(TURBO_BASELINE_VERSION)
    expect(manifest.baselines.turboRails.minimum).toBe(TURBO_RAILS_MINIMUM_VERSION)
    expect(manifest.baselines.turboRails.target).toBe(TURBO_RAILS_BASELINE_VERSION)
    expect(manifest.baselines.rails).toBe(RAILS_BASELINE_VERSION)
  })

  test("keeps fixture references within the shared XML source directory", () => {
    expect(() => fixtureUrl("fixtures/document-basic.xml")).not.toThrow()
    for (const invalidPath of [
      "/tmp/outside.xml",
      "fixtures/../outside.xml",
      "fixtures/document.txt",
    ]) {
      expect(() => fixtureUrl(invalidPath)).toThrow(
        "Protocol fixtures must be local XML files under protocol/fixtures",
      )
    }
  })

  test("accepts every declared document and Stream fixture", async () => {
    const manifest = await loadManifest()
    for (const fixture of manifest.fixtures) {
      if (fixture.expect.outcome !== "accepted") continue

      const xml = await readFile(fixtureUrl(fixture.file), "utf8")
      if (fixture.expect.normalized) {
        expect(normalizeFixture(xml, fixture)).toEqual(fixture.expect.normalized.nodes)
      } else {
        if (!fixture.expect.streamActions) throw new Error(`Missing assertions for ${fixture.id}`)
        expect(normalizeStreamActions(xml)).toEqual(fixture.expect.streamActions)
      }
    }
  })

  test("applies every declared Stream behavior fixture", async () => {
    const manifest = await loadManifest()
    for (const fixture of manifest.behaviorFixtures) {
      const documentXml = await readFile(fixtureUrl(fixture.documentFile), "utf8")
      const streamXml = await readFile(fixtureUrl(fixture.streamFile), "utf8")
      const expectedDocumentXml = await readFile(fixtureUrl(fixture.expectedDocumentFile), "utf8")
      const session = new DocumentSession(parseExpoTurboDocument(documentXml))
      const initialIdentities = new Map(
        fixture.identityAssertions.map((assertion) => {
          const node = session.tree.getElementById(assertion.id)
          if (!node) {
            throw new Error(
              `Protocol behavior fixture ${fixture.id} is missing initial id ${assertion.id}`,
            )
          }
          return [assertion.id, node] as const
        }),
      )

      const report = await dispatchTurboStreamFragment(session, streamXml)

      expect(
        report.actions.map(({ action, appliedTargets, matchedTargets, status }) => ({
          action,
          appliedTargets,
          matchedTargets,
          status,
        })),
      ).toEqual([...fixture.expectedReports])
      expect(serializeExpoTurboTree(session.tree)).toBe(
        serializeExpoTurboTree(parseExpoTurboDocument(expectedDocumentXml)),
      )
      for (const assertion of fixture.identityAssertions) {
        const initial = initialIdentities.get(assertion.id)
        const final = session.tree.getElementById(assertion.id)
        if (assertion.outcome === "retained") expect(final).toBe(initial)
        if (assertion.outcome === "replaced") {
          expect(final).toBeDefined()
          expect(final).not.toBe(initial)
        }
        if (assertion.outcome === "removed") expect(final).toBeUndefined()
      }
    }
  })

  test("rejects every declared unsafe fixture", async () => {
    const manifest = await loadManifest()
    for (const fixture of manifest.fixtures) {
      if (fixture.expect.outcome !== "rejected") continue

      const xml = await readFile(fixtureUrl(fixture.file), "utf8")
      expect(() => normalizeFixture(xml, fixture)).toThrow()
    }
  })
})
