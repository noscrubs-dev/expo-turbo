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
  presenceCodec,
  stringCodec,
  tokenListCodec,
} from "./codecs"
import { createRegistry, defineComponent, defineComponentModule } from "./registry"

const CARD_STYLE_TOKENS = ["layout:row", "space:roomy", "tone:featured"] as const

const card = defineComponent({
  aliases: ["LegacyCard"],
  attributes: {
    count: { codec: integerCodec, prop: "count" },
    disabled: { codec: presenceCodec, prop: "disabled" },
    enabled: { codec: booleanCodec, prop: "enabled" },
    form: { codec: stringCodec, prop: "form" },
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
    disabled: z.boolean().default(false),
    enabled: z.boolean().default(true),
    form: z.string().optional(),
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
      disabled: false,
      enabled: true,
      styleTokens: [],
      title: "Typed",
      tone: "positive",
    }
    expect(typedProps.title).toBe("Typed")

    const registry = createRegistry(primitives)
    const decoded = registry.decode(
      element(
        '<DemoCard id="card" autofocus="false" class="featured" data-state="ready" dir="rtl" dirname="card.dir" form="profile" heading="Hello" count="02" enabled="false" style-tokens="tone:featured space:roomy"><DemoText>Child</DemoText></DemoCard>',
      ),
    )

    expect(decoded.definition).toBe(card)
    expect(decoded.definition.morphState).toBe("preserve")
    expect(decoded.props).toEqual({
      count: 2,
      disabled: false,
      enabled: false,
      form: "profile",
      styleTokens: ["tone:featured", "space:roomy"],
      title: "Hello",
      tone: "neutral",
    })
    expect(decoded.protocol).toEqual({
      autofocus: true,
      classNames: ["featured"],
      data: { state: "ready" },
      direction: "rtl",
      dirname: "card.dir",
      form: "profile",
      id: "card",
    })
    expect(decoded.children.filter(isElement)).toHaveLength(1)
    expect(registry.resolve("LegacyCard")).toBe(card)
    expect(registry.get("DemoCard")).toBe(card)
    expect(
      registry.capabilities.components.find((component) => component.tag === "DemoCard")
        ?.morphState,
    ).toBe("preserve")

    for (const value of ["", "false", "disabled"]) {
      expect(
        registry.decode(element(`<DemoCard heading="Present" count="1" disabled="${value}" />`))
          .props,
      ).toMatchObject({ disabled: true })
    }
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
    expect(() =>
      registry.decode(element('<DemoCard heading="Hello" count="1" dir="sideways" />')),
    ).toThrow(PropsError)
    expect(() => registry.decode(element("<DemoText><DemoCard /></DemoText>"))).toThrow(
      /text children only/,
    )
    expect(() =>
      defineComponent({
        attributes: {},
        children: "none",
        component: () => null,
        morphState: "invalid" as "reset",
        schema: z.object({}),
        tag: "InvalidMorphState",
      }),
    ).toThrow(RegistryError)
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

  test("publishes explicit form ownership and container capability metadata", () => {
    const owner = defineComponent({
      attributes: {},
      children: "nodes",
      component: () => null,
      formOwner: true,
      schema: z.object({}),
      tag: "DemoForm",
    })
    const fieldset = defineComponent({
      aliases: ["LegacyFieldset"],
      attributes: {},
      children: "nodes",
      component: () => null,
      formContainer: "fieldset",
      schema: z.object({}),
      tag: "DemoFieldset",
    })
    const datalist = defineComponent({
      aliases: ["LegacyDatalist"],
      attributes: {},
      children: "nodes",
      component: () => null,
      formContainer: "datalist",
      schema: z.object({}),
      tag: "DemoDatalist",
    })
    const legend = defineComponent({
      attributes: {},
      children: "nodes",
      component: () => null,
      formContainer: "legend",
      schema: z.object({}),
      tag: "DemoLegend",
    })
    const registry = createRegistry(
      defineComponentModule({
        components: [owner, datalist, fieldset, legend],
        name: "forms",
        version: "0.1.0",
      }),
    )

    expect(owner.formOwner).toBe(true)
    expect(datalist.formContainer).toBe("datalist")
    expect(fieldset.formContainer).toBe("fieldset")
    expect(registry.formContainerRole(element("<LegacyDatalist />"))).toBe("datalist")
    expect(registry.formContainerRole(element("<LegacyFieldset />"))).toBe("fieldset")
    expect(registry.formContainerRole(element("<DemoLegend />"))).toBe("legend")
    expect(registry.formContainerRole(element("<DemoForm />"))).toBeUndefined()
    expect(
      registry.capabilities.components.find((component) => component.tag === "DemoForm"),
    ).toMatchObject({
      formOwner: true,
      tag: "DemoForm",
    })
    expect(
      registry.capabilities.components.find((component) => component.tag === "DemoDatalist"),
    ).toMatchObject({ formContainer: "datalist", tag: "DemoDatalist" })
    expect(
      registry.capabilities.components.find((component) => component.tag === "DemoFieldset"),
    ).toMatchObject({ formContainer: "fieldset", tag: "DemoFieldset" })
    expect(
      registry.capabilities.components.find((component) => component.tag === "DemoLegend"),
    ).toMatchObject({ formContainer: "legend", tag: "DemoLegend" })
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
    expect(() =>
      defineComponent({
        attributes: {},
        children: "nodes",
        component: () => null,
        formContainer: "invalid" as never,
        schema: z.object({}),
        tag: "InvalidFormContainer",
      }),
    ).toThrow(/datalist, fieldset, or legend/)

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
    expect(
      first.capabilities.components
        .find((component) => component.tag === "DemoCard")
        ?.attributes.find((attribute) => attribute.name === "disabled"),
    ).toMatchObject({ codec: "presence", prop: "disabled" })

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
