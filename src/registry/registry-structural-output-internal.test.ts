import { describe, expect, test } from "bun:test"
import { z } from "zod"

import { parseExpoTurboDocument } from "../core/parser"
import type { ProtocolElement } from "../core/tree"
import {
  createRegistry,
  defineComponent,
  defineComponentModule,
  type RegistryRenderDecodeResult,
} from "./registry"
import { analyzeRegistryStructuralOutput } from "./registry-structural-output-internal"

const invisible = defineComponent({
  attributes: {},
  children: "none",
  component: () => null,
  schema: z.object({}),
  tag: "Invisible",
})
const registry = createRegistry(
  defineComponentModule({
    components: [invisible],
    name: "structural-output",
    version: "1.0.0",
  }),
)

function nodes(xml: string) {
  return parseExpoTurboDocument(xml).document.children
}

describe("registry structural output", () => {
  test("counts registered components and meaningful text as potential output", () => {
    expect(analyzeRegistryStructuralOutput(registry, nodes("<Invisible />"))).toMatchObject({
      diagnostics: [],
      hasOutput: true,
      hasVocabularyIssues: false,
    })
    expect(
      analyzeRegistryStructuralOutput(registry, nodes("<Unknown>Fallback</Unknown>")),
    ).toMatchObject({
      hasOutput: true,
      hasVocabularyIssues: true,
    })
  })

  test("collects all transparent diagnostics from a blank fallback", () => {
    const analysis = analyzeRegistryStructuralOutput(
      registry,
      nodes("<Unknown><Future><!-- ignored --></Future></Unknown>"),
    )

    expect(analysis.hasOutput).toBe(false)
    expect(analysis.hasVocabularyIssues).toBe(true)
    expect(analysis.diagnostics.map((diagnostic) => diagnostic.issues[0]?.tag)).toEqual([
      "Unknown",
      "Future",
    ])
    expect(Object.isFrozen(analysis)).toBe(true)
    expect(Object.isFrozen(analysis.diagnostics)).toBe(true)
  })

  test("treats pure protocol envelopes and whitespace as non-output", () => {
    for (const xml of [
      "<Unknown>   <!-- ignored --></Unknown>",
      '<turbo-stream action="remove" target="missing" />',
      "<template />",
    ]) {
      expect(analyzeRegistryStructuralOutput(registry, nodes(xml)).hasOutput).toBe(false)
    }
  })

  test("counts runtime-managed content regions as potential output", () => {
    // A Frame loads through its own request and a Cable source feeds later
    // Streams. Classifying either as blank would unmount the node that produces
    // the content, so an unknown wrapper around one must not blank the screen.
    for (const xml of [
      '<turbo-frame id="empty" />',
      '<turbo-frame id="lazy" src="/detail" loading="lazy" />',
      '<Unknown><turbo-frame id="detail" src="/detail" /></Unknown>',
      '<turbo-cable-stream-source id="source" channel="Demo" />',
      '<Unknown><turbo-cable-stream-source id="source" channel="Demo" /></Unknown>',
    ]) {
      expect(analyzeRegistryStructuralOutput(registry, nodes(xml)).hasOutput).toBe(true)
    }
  })

  test("stops at the first renderable node because diagnostics go unused", () => {
    let decodes = 0
    const counting = {
      decodeForRender(element: ProtocolElement) {
        decodes += 1
        return registry.decodeForRender(element)
      },
    }
    const analysis = analyzeRegistryStructuralOutput(
      counting,
      nodes("<Root><Invisible /><Future /><Future /></Root>"),
    )

    expect(analysis.hasOutput).toBe(true)
    // The unknown root unwraps, then the first registered child ends the walk
    // without decoding the two trailing unknown siblings.
    expect(decodes).toBe(2)
  })

  test("leaves non-vocabulary decoder failures to the render path", () => {
    const failing = {
      decodeForRender(_element: ProtocolElement): RegistryRenderDecodeResult<typeof invisible> {
        throw new Error("decode failed")
      },
    }

    expect(analyzeRegistryStructuralOutput(failing, nodes("<Broken />"))).toMatchObject({
      diagnostics: [],
      hasOutput: true,
      hasVocabularyIssues: false,
    })
  })
})
