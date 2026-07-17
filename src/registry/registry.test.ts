import { describe, expect, test } from "bun:test"
import type { ComponentProps } from "react"
import { z } from "zod"

import { PropsError, RegistryError } from "../core/errors"
import { parseExpoTurboDocument } from "../core/parser"
import { isElement } from "../core/tree"
import {
  booleanCodec,
  enumCodec,
  integerCodec,
  jsonCodec,
  stringCodec,
  tokenListCodec,
} from "./codecs"
import { createRegistry, defineComponent, defineComponentModule } from "./registry"

const CARD_STYLE_TOKENS = ["layout:row", "space:roomy", "tone:featured"] as const

const card = defineComponent({
  aliases: ["LegacyCard"],
  attributes: {
    count: { codec: integerCodec, prop: "count" },
    enabled: { codec: booleanCodec, prop: "enabled" },
    heading: { codec: stringCodec, prop: "title" },
    "style-tokens": {
      codec: tokenListCodec("card-style", CARD_STYLE_TOKENS, { maxTokens: 2 }),
      prop: "styleTokens",
    },
    tone: { codec: enumCodec(["neutral", "positive"]), prop: "tone" },
  },
  children: "nodes",
  component: (props) => `${props.title}:${props.count}`,
  schema: z.object({
    count: z.number().int(),
    enabled: z.boolean().default(true),
    styleTokens: z.array(z.enum(CARD_STYLE_TOKENS)).readonly().default([]),
    title: z.string().min(1),
    tone: z.enum(["neutral", "positive"]).default("neutral"),
  }),
  tag: "DemoCard",
})

const text = defineComponent({
  attributes: {},
  children: "text",
  component: (_props) => "text",
  schema: z.object({}),
  tag: "DemoText",
})

const primitives = defineComponentModule({
  components: [card, text],
  name: "primitives",
  version: "0.1.0",
})

function element(xml: string) {
  const root = parseExpoTurboDocument(xml).document.children.find(isElement)
  if (!root) throw new Error("fixture lost its root element")
  return root
}

describe("typed component registry", () => {
  test("preserves inferred component props and decodes explicit attributes", () => {
    const typedProps: ComponentProps<typeof card.component> = {
      count: 1,
      enabled: true,
      styleTokens: [],
      title: "Typed",
      tone: "positive",
    }
    expect(typedProps.title).toBe("Typed")

    const registry = createRegistry(primitives)
    const decoded = registry.decode(
      element(
        '<DemoCard id="card" class="featured" data-state="ready" heading="Hello" count="02" enabled="false" style-tokens="tone:featured space:roomy"><DemoText>Child</DemoText></DemoCard>',
      ),
    )

    expect(decoded.definition).toBe(card)
    expect(decoded.props).toEqual({
      count: 2,
      enabled: false,
      styleTokens: ["tone:featured", "space:roomy"],
      title: "Hello",
      tone: "neutral",
    })
    expect(decoded.protocol).toEqual({
      classNames: ["featured"],
      data: { state: "ready" },
      id: "card",
    })
    expect(decoded.children.filter(isElement)).toHaveLength(1)
    expect(registry.resolve("LegacyCard")).toBe(card)
    expect(registry.get("DemoCard")).toBe(card)
  })

  test("fails closed for unknown names, attributes, invalid codecs, props, and child slots", () => {
    const registry = createRegistry(primitives)

    expect(() => registry.decode(element("<Unknown />"))).toThrow(RegistryError)
    expect(() =>
      registry.decode(element('<DemoCard heading="Hello" count="1" surprise="x" />')),
    ).toThrow(PropsError)
    expect(() =>
      registry.decode(element('<DemoCard heading="Hello" count="1" enabled="yes" />')),
    ).toThrow(PropsError)
    expect(() =>
      registry.decode(element('<DemoCard heading="Hello" count="1" style-tokens="missing" />')),
    ).toThrow(PropsError)
    expect(() =>
      registry.decode(
        element(
          '<DemoCard heading="Hello" count="1" style-tokens="tone:featured tone:featured" />',
        ),
      ),
    ).toThrow(PropsError)
    expect(() =>
      registry.decode(
        element(
          '<DemoCard heading="Hello" count="1" style-tokens="tone:featured space:roomy layout:row" />',
        ),
      ),
    ).toThrow(PropsError)
    expect(() =>
      registry.decode(element('<DemoCard heading="Hello" count="1" style="{}" />')),
    ).toThrow(PropsError)
    expect(() =>
      registry.decode(element('<DemoCard heading="Hello" count="1" className="dynamic" />')),
    ).toThrow(PropsError)
    expect(() => registry.decode(element('<DemoCard heading="" count="1" />'))).toThrow(PropsError)
    expect(() => registry.decode(element("<DemoText><DemoCard /></DemoText>"))).toThrow(
      /text children only/,
    )
  })

  test("decodes text children through the shared whitespace contract", () => {
    const registry = createRegistry(primitives)

    expect(registry.decode(element("<DemoText>one\n  two</DemoText>")).text).toBe("one two")
    expect(
      registry.decode(element('<DemoText xml:space="preserve">one\n  two</DemoText>')).text,
    ).toBe("one\n  two")
    expect(registry.decode(element("<DemoText><![CDATA[one\n  two]]></DemoText>")).text).toBe(
      "one\n  two",
    )
  })

  test("rejects reserved and duplicate ownership with both module names", () => {
    expect(() =>
      defineComponent({
        attributes: {},
        children: "nodes",
        component: () => null,
        schema: z.object({}),
        tag: "turbo-frame",
      }),
    ).toThrow(/reserved/)

    const duplicate = defineComponentModule({
      components: [card],
      name: "commerce",
      version: "0.1.0",
    })
    expect(() => createRegistry(primitives, duplicate)).toThrow(/primitives.*commerce/)
    expect(() => createRegistry(primitives, primitives)).toThrow(/Duplicate component module/)
  })

  test("builds deterministic capability hashes independent of composition order", () => {
    const state = defineComponent({
      attributes: {
        payload: {
          codec: jsonCodec("bounded-state", z.object({ active: z.boolean() }), { maxBytes: 64 }),
          deprecated: "Use active instead",
          prop: "state",
        },
      },
      children: "none",
      component: (props) => props.state.active,
      schema: z.object({ state: z.object({ active: z.boolean() }) }),
      tag: "DemoState",
    })
    const stateModule = defineComponentModule({
      components: [state],
      name: "state",
      version: "0.1.0",
    })

    const first = createRegistry(primitives, stateModule)
    const second = createRegistry(stateModule, primitives)
    expect(first.capabilities.hash).toBe(second.capabilities.hash)
    expect(Object.isFrozen(first.capabilities.components[0])).toBe(true)
    expect(Object.isFrozen(first.capabilities.components[0]?.attributes)).toBe(true)
    expect(first.capabilities.components.map((component) => component.tag)).toEqual([
      "DemoCard",
      "DemoState",
      "DemoText",
    ])

    const decoded = first.decode(element('<DemoState payload="{&quot;active&quot;:true}" />'))
    expect(decoded.props).toEqual({ state: { active: true } })
    expect(decoded.warnings).toEqual(["Use active instead"])
    expect(() => first.decode(element(`<DemoState payload="${"x".repeat(65)}" />`))).toThrow(
      PropsError,
    )

    const canonicalTokens = tokenListCodec("card-style", CARD_STYLE_TOKENS, { maxTokens: 2 })
    expect(
      tokenListCodec("card-style", [...CARD_STYLE_TOKENS].reverse(), { maxTokens: 2 }).name,
    ).toBe(canonicalTokens.name)
    expect(tokenListCodec("card-style", CARD_STYLE_TOKENS, { maxTokens: 3 }).name).not.toBe(
      canonicalTokens.name,
    )
    expect(tokenListCodec("card-style:tone", ["featured"], { maxTokens: 2 }).name).not.toBe(
      tokenListCodec("card-style", ["tone:featured"], { maxTokens: 2 }).name,
    )
  })
})
