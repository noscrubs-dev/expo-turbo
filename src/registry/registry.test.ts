import { describe, expect, test } from "bun:test"
import type { ComponentProps } from "react"
import { z } from "zod"

import { PropsError, RegistryError } from "../core/errors"
import { parseExpoTurboDocument } from "../core/parser"
import { serializeClientDescriptor } from "../core/protocol-request"
import { isElement } from "../core/tree"
import { attr } from "./attributes"
import {
  type AttributeCodec,
  booleanCodec,
  enumCodec,
  integerCodec,
  jsonCodec,
  numberCodec,
  presenceCodec,
  stringCodec,
  tokenListCodec,
} from "./codecs"
import {
  bindComponent,
  type ComponentRegistry,
  capabilityManifestJSON,
  component,
  createCapabilityManifest,
  createRegistry,
  defineCapabilityModule,
  defineComponent,
  defineComponentDefinition,
  defineComponentModule,
  defineRegistry,
  formOwner,
  nodes,
  none,
  packageIdentity,
  type RegistryCapabilityManifest,
  type RegistryComponent,
  text as textChildren,
} from "./registry"
import { decodeRegistryElementForRender } from "./registry-decode-internal"

const CARD_STYLE_TOKENS = ["layout:row", "space:roomy", "tone:featured"] as const
const TEST_MODULE = { name: "test-primitives", version: "0.1.0" } as const
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

const trimmedStringCodec: AttributeCodec<string> = {
  decode: (value) => value.trim(),
  name: "trimmed-string",
}

const derivedCardDefinition = defineComponentDefinition({
  attributes: {
    "accessibility-label": attr(stringCodec, z.string().trim().min(1)).optional(),
    disabled: attr(presenceCodec).default(false),
    heading: attr(trimmedStringCodec, z.string().min(1)).prop("title").deprecated("Use title"),
    "original-price": attr(numberCodec),
    tone: attr(enumCodec(["neutral", "positive"])).default("neutral"),
  },
  children: "none",
  tag: "DerivedCard",
})

const derivedCard = bindComponent(
  derivedCardDefinition,
  (props) => `${props.title}:${props.originalPrice}`,
)

const primitives = defineComponentModule({
  components: [card, text],
  name: "primitives",
  version: "0.1.0",
})

const derivedCapabilities = defineCapabilityModule({
  components: [derivedCardDefinition],
  name: "derived-primitives",
  version: "0.1.0",
})

const derivedPrimitives = defineComponentModule({
  components: [derivedCard],
  name: "derived-primitives",
  version: "0.1.0",
})

function element(xml: string) {
  const root = parseExpoTurboDocument(xml).document.children.find(isElement)
  if (!root) throw new Error("fixture lost its root element")
  return root
}

describe("typed component registry", () => {
  test("declares each component once and uses only its object key as the wire tag", () => {
    const render = ({ displayName }: Readonly<{ displayName: string }>) => displayName
    render.displayName = "MinifiedWrapper"
    const registry = defineRegistry({
      module: TEST_MODULE,
      components: {
        StableWireTag: component({
          attributes: {
            "display-name": attr(stringCodec, z.string().trim().min(1)),
          },
          children: none,
          render,
        }),
      },
    })

    expect(registry.capabilities.components.map(({ tag }) => tag)).toEqual(["StableWireTag"])
    expect(registry.resolve("StableWireTag")?.component).not.toBe(render)
    expect(registry.resolve("StableWireTag")?.component).toHaveProperty(
      "displayName",
      "StableWireTag",
    )
    expect(registry.resolve("StableWireTag")?.component).toBe(
      registry.resolve("StableWireTag")?.component,
    )
    expect(render.displayName).toBe("MinifiedWrapper")
    expect(registry.resolve("MinifiedWrapper")).toBeUndefined()
    expect(registry.decode(element('<StableWireTag display-name=" Ada " />')).props).toEqual({
      displayName: "Ada",
    })
  })

  test("does not mutate frozen or shared caller renderers when it adds React names", () => {
    const shared = Object.freeze(function LibraryButton() {
      return null
    })
    const declaration = component({ children: none, render: shared })

    const registry = defineRegistry({
      module: TEST_MODULE,
      components: { DemoButton: declaration, SecondaryButton: declaration },
    })

    expect((shared as Readonly<{ displayName?: string }>).displayName).toBeUndefined()
    expect(shared.name).toBe("LibraryButton")
    expect(registry.resolve("DemoButton")?.component).toHaveProperty("displayName", "DemoButton")
    expect(registry.resolve("SecondaryButton")?.component).toHaveProperty(
      "displayName",
      "SecondaryButton",
    )
  })

  test("derives package and vocabulary identity without a typed version", () => {
    const registry = defineRegistry({
      package: packageIdentity({ name: "expo-turbo-example", version: "99.0.0" }),
      components: {
        DemoText: component({ children: textChildren, render: ({ children }) => children }),
      },
    })

    expect(registry.capabilities.modules).toEqual([{ name: "expo-turbo-example" }])
    expect(serializeClientDescriptor(registry.capabilities.hash)).toMatch(
      /^v=1; proto=0\.1; rt=0\.3\.0; vocab=sha256-128:[0-9a-f]{32}$/,
    )
  })

  test("rejects unbranded component entries with a registry error", () => {
    expect(() =>
      defineRegistry({
        module: TEST_MODULE,
        components: {
          WrongApi: defineComponent({
            attributes: {},
            children: "none",
            component: () => null,
            schema: z.object({}),
            tag: "WrongApi",
          }),
        },
      } as unknown as Parameters<typeof defineRegistry>[0]),
    ).toThrow(RegistryError)
  })

  test("rejects styles on the explicit schema escape hatch at runtime", () => {
    expect(() =>
      component({
        attributes: {},
        children: none,
        render: () => null,
        schema: z.object({ styleTokens: z.array(z.string()) }),
        styles: attr(tokenListCodec("unsafe-style", ["tone:quiet"], { maxTokens: 1 })),
      } as never),
    ).toThrow(RegistryError)
  })

  test("derives empty props and child behavior without empty declarations", () => {
    const registry = defineRegistry({
      module: TEST_MODULE,
      components: {
        NodeContainer: component({
          children: nodes,
          render({ children }) {
            return children
          },
        }),
        TextContainer: component({
          children: textChildren,
          render({ children }) {
            return children
          },
        }),
      },
    })

    expect(registry.decode(element("<NodeContainer />")).props).toEqual({})
    expect(registry.decode(element("<TextContainer>Hello</TextContainer>")).text).toBe("Hello")
  })

  test("keeps aliases, style acceptance, form role, and reset morph policy explicit", () => {
    const styleTokens = ["tone:quiet", "space:roomy"] as const
    const registry = defineRegistry({
      module: TEST_MODULE,
      components: {
        StyledForm: component({
          aliases: ["LegacyStyledForm"],
          children: nodes,
          morphState: "reset",
          role: formOwner,
          styles: attr(tokenListCodec("styled-form", styleTokens, { maxTokens: 1 })).default([]),
          render({ children, styleTokens }) {
            return styleTokens.length > 0 ? children : null
          },
        }),
      },
    })

    const definition = registry.resolve("StyledForm")
    expect(registry.resolve("LegacyStyledForm")).toBe(definition)
    expect(definition).toMatchObject({ formOwner: true, morphState: "reset" })
    expect(definition?.attributeBindings["style-tokens"]?.prop).toBe("styleTokens")
    expect(registry.decode(element("<StyledForm />")).props).toEqual({ styleTokens: [] })
    expect(registry.decode(element('<StyledForm style-tokens="tone:quiet" />')).props).toEqual({
      styleTokens: ["tone:quiet"],
    })
  })

  test("keeps one explicit schema escape hatch for irreducible prop rules", () => {
    const rangeSchema = z
      .object({
        currency: z.string().default("USD"),
        end: z.number(),
        start: z.number(),
        title: z.string(),
      })
      .refine(({ end, start }) => end >= start)
    const registry = defineRegistry({
      module: TEST_MODULE,
      components: {
        PriceRange: component({
          attributes: {
            end: { codec: numberCodec, prop: "end" },
            heading: { codec: stringCodec, prop: "title" },
            start: { codec: numberCodec, prop: "start" },
            title: { codec: stringCodec, prop: "title" },
          },
          children: none,
          render({ currency, end, start, title }) {
            return `${title}:${currency}:${start}-${end}`
          },
          schema: rangeSchema,
        }),
      },
    })

    expect(
      registry.decode(element('<PriceRange heading="Sale" start="1" end="2" />')).props,
    ).toEqual({ currency: "USD", end: 2, start: 1, title: "Sale" })
    expect(() => registry.decode(element('<PriceRange title="Sale" start="2" end="1" />'))).toThrow(
      PropsError,
    )
  })

  test("throws for an unknown component in development before transparent fallback", () => {
    const development = globalThis as typeof globalThis & { __DEV__?: boolean }
    const previous = development.__DEV__
    development.__DEV__ = true
    try {
      const registry = defineRegistry({
        module: TEST_MODULE,
        components: {
          Known: component({ children: none, render: () => null }),
        },
      })
      const unknown = element("<Unknown><Known /></Unknown>")

      expect(registry.resolve("Unknown")).toBeUndefined()
      expect(() => registry.decodeForRender(unknown)).toThrow(/Unknown component "Unknown"/)
    } finally {
      if (previous === undefined) delete development.__DEV__
      else development.__DEV__ = previous
    }
  })

  test("unwraps and emits a mandatory deduplicated diagnostic in production", () => {
    const development = globalThis as typeof globalThis & { __DEV__?: boolean }
    const previous = development.__DEV__
    const originalError = console.error
    const diagnostics: unknown[][] = []
    development.__DEV__ = false
    console.error = (...values: unknown[]) => diagnostics.push(values)
    try {
      const registry = defineRegistry({
        module: TEST_MODULE,
        components: {
          Known: component({ children: none, render: () => null }),
        },
      })
      const unknown = element("<Unknown><Known /></Unknown>")

      const first = registry.decodeForRender(unknown)
      const second = registry.decodeForRender(unknown)
      expect(registry.resolve("Unknown")).toBeUndefined()
      expect(first.status).toBe("transparent")
      expect(second.status).toBe("transparent")
      if (first.status !== "transparent") throw new Error("unknown component did not unwrap")
      expect(first.children.filter(isElement).map(({ tagName }) => tagName)).toEqual(["Known"])
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toEqual([
        "Expo Turbo registry contract fallback",
        { kind: "component", tag: "Unknown" },
      ])
    } finally {
      console.error = originalError
      if (previous === undefined) delete development.__DEV__
      else development.__DEV__ = previous
    }
  })

  test("retries a mandatory production diagnostic after its sink throws", () => {
    const development = globalThis as typeof globalThis & { __DEV__?: boolean }
    const previous = development.__DEV__
    const originalError = console.error
    let attempts = 0
    development.__DEV__ = false
    console.error = () => {
      attempts += 1
      if (attempts === 1) throw new Error("diagnostic sink failed")
    }
    try {
      const registry = defineRegistry({
        module: TEST_MODULE,
        components: {
          Known: component({ children: none, render: () => null }),
        },
      })
      const unknown = element("<Unknown />")

      expect(registry.resolve("Unknown")).toBeUndefined()
      expect(registry.decodeForRender(unknown).status).toBe("transparent")
      expect(registry.decodeForRender(unknown).status).toBe("transparent")
      expect(registry.decodeForRender(unknown).status).toBe("transparent")
      expect(attempts).toBe(2)
    } finally {
      console.error = originalError
      if (previous === undefined) delete development.__DEV__
      else development.__DEV__ = previous
    }
  })

  test("bounds retries when the mandatory production diagnostic sink always throws", () => {
    const development = globalThis as typeof globalThis & { __DEV__?: boolean }
    const previous = development.__DEV__
    const originalError = console.error
    let attempts = 0
    development.__DEV__ = false
    console.error = () => {
      attempts += 1
      throw new Error("diagnostic sink failed")
    }
    try {
      const registry = defineRegistry({
        module: TEST_MODULE,
        components: { Known: component({ children: none, render: () => null }) },
      })
      const unknown = element("<Unknown />")

      expect(registry.resolve("Unknown")).toBeUndefined()
      for (let index = 0; index < 50; index += 1) {
        expect(registry.decodeForRender(unknown).status).toBe("transparent")
      }
      expect(attempts).toBe(3)
    } finally {
      console.error = originalError
      if (previous === undefined) delete development.__DEV__
      else development.__DEV__ = previous
    }
  })

  test("uses production fallback in tooling unless development is explicit", () => {
    const development = globalThis as typeof globalThis & { __DEV__?: boolean }
    const previousDevelopment = development.__DEV__
    const previousEnvironment = process.env.NODE_ENV
    const originalError = console.error
    const diagnostics: unknown[][] = []
    delete development.__DEV__
    delete process.env.NODE_ENV
    console.error = (...values: unknown[]) => diagnostics.push(values)
    try {
      const registry = defineRegistry({
        module: TEST_MODULE,
        components: {
          Known: component({ children: none, render: () => null }),
        },
      })
      const unknown = element("<Unknown />")

      expect(registry.resolve("Unknown")).toBeUndefined()
      expect(registry.decodeForRender(unknown).status).toBe("transparent")
      expect(diagnostics).toHaveLength(1)
      process.env.NODE_ENV = "development"
      expect(() => registry.decodeForRender(unknown)).toThrow(/Unknown component "Unknown"/)
    } finally {
      console.error = originalError
      if (previousDevelopment === undefined) delete development.__DEV__
      else development.__DEV__ = previousDevelopment
      if (previousEnvironment === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousEnvironment
    }
  })

  test("quarantines invalid package identity but ignores a legacy typed version", () => {
    const spaced = defineComponentModule({ components: [card], name: " cart ", version: "1" })
    const invalidVersion = defineCapabilityModule({
      components: [derivedCardDefinition],
      name: "prices",
      version: "v2",
    })
    const noncharacter = defineComponentModule({
      components: [text],
      name: "cart\uFFFF",
      version: "1",
    })
    const surrogate = defineComponentModule({
      components: [text],
      name: "cart\uD800",
      version: "1",
    })

    const runtime = createRegistry(spaced, noncharacter, surrogate)
    const declared = defineRegistry({
      module: { name: " cart ", version: "1" },
      components: {
        DeclaredCard: component({ children: none, render: () => null }),
      },
    })
    const manifest = createCapabilityManifest(invalidVersion)
    expect(runtime.capabilities.modules).toEqual([])
    expect(runtime.capabilities.components).toEqual([])
    expect(runtime.resolve("DemoCard")).toBeUndefined()
    expect(manifest.modules).toEqual([{ name: "prices" }])
    expect(manifest.components.map(({ tag }) => tag)).toEqual(["DerivedCard"])
    expect(declared.capabilities.modules).toEqual([])
    expect(declared.capabilities.components).toEqual([])
    expect(declared.resolve("DeclaredCard")).toBeUndefined()
    expect(() =>
      defineComponentModule({ components: [], name: "cart😀", version: "1" }),
    ).not.toThrow()
    expect(
      createRegistry(defineComponentModule({ components: [card], name: "cart�" })).capabilities
        .modules,
    ).toEqual([{ name: "cart�" }])
  })

  test("rejects noncharacters in every canonical manifest identity field", () => {
    const invalid = "\uFDD0"
    const cases: readonly [string, number, () => unknown][] = [
      ["package.name", 3, () => packageIdentity({ name: `pkg${invalid}` })],
      [
        "component.tag",
        3,
        () =>
          defineComponent({
            attributes: {},
            children: none,
            component: () => null,
            schema: z.object({}),
            tag: `Tag${invalid}`,
          }),
      ],
      [
        "component.aliases[]",
        5,
        () =>
          defineComponent({
            aliases: [`Alias${invalid}`],
            attributes: {},
            children: none,
            component: () => null,
            schema: z.object({}),
            tag: "Tag",
          }),
      ],
      [
        "component.attributes[].name",
        4,
        () =>
          defineComponent({
            attributes: { [`name${invalid}`]: attr(stringCodec) },
            children: none,
            component: () => null,
            tag: "Tag",
          }),
      ],
      [
        "component.attributes[].name",
        4,
        () =>
          defineComponent({
            attributes: {
              [`name${invalid}`]: { codec: stringCodec, prop: "name" },
            },
            children: none,
            component: () => null,
            schema: z.object({ name: z.string() }),
            tag: "Tag",
          }),
      ],
      ["attribute.prop", 4, () => attr(stringCodec).prop(`prop${invalid}`)],
      [
        "component.attributes[].prop",
        4,
        () =>
          defineComponent({
            attributes: {
              title: { codec: stringCodec, prop: `prop${invalid}` as "title" },
            },
            children: none,
            component: () => null,
            schema: z.object({ title: z.string() }),
            tag: "Tag",
          }),
      ],
      [
        "component.attributes[].codec",
        5,
        () =>
          defineComponent({
            attributes: {
              title: {
                codec: { decode: (value: string) => value, name: `codec${invalid}` },
                prop: "title",
              },
            },
            children: none,
            component: () => null,
            schema: z.object({ title: z.string() }),
            tag: "Tag",
          }),
      ],
      [
        "component.attributes[].codec",
        5,
        () =>
          defineComponent({
            attributes: {
              title: attr(
                {
                  decode: (value: string) => value,
                  name: `codec${invalid}`,
                },
                z.string(),
              ),
            },
            children: none,
            component: () => null,
            tag: "Tag",
          }),
      ],
    ]

    for (const [path, index, operation] of cases) {
      expect(operation).toThrow(
        `Expo Turbo registry identifier ${path} contains Unicode noncharacter U+FDD0 at scalar index ${index}`,
      )
      try {
        operation()
      } catch (error) {
        expect(error).toBeInstanceOf(RegistryError)
        expect(error).toMatchObject({ code: "registry" })
      }
    }
  })

  test("rejects non-string identity values in explicit and derived attributes", () => {
    const cases: readonly [string, string, () => unknown][] = [
      [
        "component.tag",
        "number",
        () =>
          defineComponent({
            attributes: {},
            children: none,
            component: () => null,
            schema: z.object({}),
            tag: 1 as never,
          }),
      ],
      [
        "component.aliases[]",
        "null",
        () =>
          defineComponent({
            aliases: [null as never],
            attributes: {},
            children: none,
            component: () => null,
            schema: z.object({}),
            tag: "Tag",
          }),
      ],
      ["attribute.prop", "number", () => attr(stringCodec).prop(1 as never)],
      [
        "component.attributes[].prop",
        "number",
        () =>
          defineComponent({
            attributes: { title: { codec: stringCodec, prop: 1 as never } },
            children: none,
            component: () => null,
            schema: z.object({ title: z.string() }),
            tag: "Tag",
          }),
      ],
      [
        "component.attributes[].codec",
        "number",
        () =>
          defineComponent({
            attributes: {
              title: { codec: { ...stringCodec, name: 1 as never }, prop: "title" },
            },
            children: none,
            component: () => null,
            schema: z.object({ title: z.string() }),
            tag: "Tag",
          }),
      ],
      [
        "component.attributes[].codec",
        "number",
        () =>
          defineComponent({
            attributes: {
              title: attr({ ...stringCodec, name: 1 as never }, z.string()),
            },
            children: none,
            component: () => null,
            tag: "Tag",
          }),
      ],
    ]

    for (const [path, type, operation] of cases) {
      expect(operation).toThrow(
        `Expo Turbo registry identifier ${path} must be a string, got ${type}`,
      )
      try {
        operation()
      } catch (error) {
        expect(error).toBeInstanceOf(RegistryError)
        expect(error).toMatchObject({ code: "registry" })
      }
    }
  })

  test("validates canonical deprecation messages without rejecting prose", () => {
    const validMessage = "Use title instead: café 😀"
    const explicit = defineComponent({
      attributes: {
        heading: { codec: stringCodec, deprecated: validMessage, prop: "title" },
      },
      children: none,
      component: () => null,
      schema: z.object({ title: z.string() }),
      tag: "ExplicitMessage",
    })
    const derived = defineComponent({
      attributes: {
        heading: attr(stringCodec).prop("title").deprecated(validMessage),
      },
      children: none,
      component: () => null,
      tag: "DerivedMessage",
    })
    const module = defineComponentModule({
      components: [explicit, derived],
      name: "messages",
    })
    const json = capabilityManifestJSON(module)
    const changed = defineComponentModule({
      components: [
        defineComponent({
          attributes: {
            heading: { codec: stringCodec, deprecated: "Use another title", prop: "title" },
          },
          children: none,
          component: () => null,
          schema: z.object({ title: z.string() }),
          tag: "ExplicitMessage",
        }),
        derived,
      ],
      name: "messages",
    })

    expect(JSON.parse(json)).toEqual(createCapabilityManifest(module))
    expect(json).toContain(JSON.stringify(validMessage).slice(1, -1))
    expect(createCapabilityManifest(changed).hash).not.toBe(createCapabilityManifest(module).hash)

    for (const [message, kind, codePoint] of [
      [`Use title ${"\uD800"}`, "lone surrogate", "D800"],
      [`Use title ${"\uFDD0"}`, "Unicode noncharacter", "FDD0"],
    ] as const) {
      expect(() => attr(stringCodec).deprecated(message)).toThrow(
        `Expo Turbo registry identifier attribute.deprecated contains ${kind} U+${codePoint} at scalar index 10`,
      )
      expect(() =>
        defineComponent({
          attributes: {
            heading: { codec: stringCodec, deprecated: message, prop: "title" },
          },
          children: none,
          component: () => null,
          schema: z.object({ title: z.string() }),
          tag: "InvalidMessage",
        }),
      ).toThrow(
        `Expo Turbo registry identifier component.attributes[].deprecated contains ${kind} U+${codePoint} at scalar index 10`,
      )
    }

    expect(() => attr(stringCodec).deprecated("normal prose with spaces")).not.toThrow()
    expect(() => attr(stringCodec).deprecated("   ")).toThrow(
      "Attribute deprecation messages must not be blank",
    )
    expect(() =>
      defineComponent({
        attributes: {
          heading: { codec: stringCodec, deprecated: "   ", prop: "title" },
        },
        children: none,
        component: () => null,
        schema: z.object({ title: z.string() }),
        tag: "BlankMessage",
      }),
    ).toThrow("Attribute deprecation messages must not be blank")

    const validDefinition = module.components[0]
    const validBinding = validDefinition?.attributeBindings.heading
    if (!validDefinition || !validBinding) throw new Error("missing valid test definition")
    const invalidManifestModule = {
      components: [
        {
          ...validDefinition,
          attributeBindings: {
            heading: { ...validBinding, deprecated: `Use title ${"\uFDD0"}` },
          },
        },
      ],
      name: "invalid-message",
    }
    expect(() => createCapabilityManifest(invalidManifestModule)).toThrow(
      "Expo Turbo registry identifier component.attributes[].deprecated contains Unicode noncharacter U+FDD0 at scalar index 10",
    )
  })

  test("derives component props from attribute definitions", () => {
    const typedProps: ComponentProps<typeof derivedCard.component> = {
      disabled: false,
      originalPrice: 12,
      title: "Typed",
      tone: "positive",
    }
    expect(typedProps.originalPrice).toBe(12)

    const registry = createRegistry(derivedPrimitives)
    const decoded = registry.decode(
      element(
        '<DerivedCard accessibility-label=" Price " disabled="" heading="  Sale  " original-price="19.5" tone="positive" />',
      ),
    )

    expect(decoded.props).toEqual({
      accessibilityLabel: "Price",
      disabled: true,
      originalPrice: 19.5,
      title: "Sale",
      tone: "positive",
    })
    expect(decoded.warnings).toEqual(["Use title"])
    expect(
      registry.decode(element('<DerivedCard heading="Default" original-price="10" />')).props,
    ).toEqual({
      disabled: false,
      originalPrice: 10,
      title: "Default",
      tone: "neutral",
    })
    expect(() =>
      registry.decode(element('<DerivedCard heading="   " original-price="10" />')),
    ).toThrow(PropsError)
  })

  test("rejects derived attribute prop collisions", () => {
    expect(() =>
      defineComponent({
        attributes: {
          "data-id": attr(stringCodec),
          dataId: attr(stringCodec),
        },
        children: "none",
        component: () => null,
        tag: "PropCollision",
      }),
    ).toThrow(/multiple attributes to prop "dataId"/)
  })

  test("keeps capability hashes stable for equivalent explicit and derived declarations", () => {
    const explicit = defineComponent({
      attributes: {
        disabled: { codec: presenceCodec, prop: "disabled" },
        heading: {
          codec: trimmedStringCodec,
          deprecated: "Use title",
          prop: "title",
        },
        "original-price": { codec: numberCodec, prop: "originalPrice" },
      },
      children: "none",
      component: () => null,
      schema: z.object({
        disabled: z.boolean().default(false),
        originalPrice: z.number(),
        title: z.string().min(1),
      }),
      tag: "EquivalentCard",
    })
    const derived = defineComponent({
      attributes: {
        disabled: attr(presenceCodec).default(false),
        heading: attr(trimmedStringCodec, z.string().min(1)).prop("title").deprecated("Use title"),
        "original-price": attr(numberCodec),
      },
      children: "none",
      component: () => null,
      tag: "EquivalentCard",
    })
    const module = (component: typeof explicit | typeof derived) =>
      defineComponentModule({
        components: [component],
        name: "equivalent",
        version: "1.0.0",
      })

    expect(createRegistry(module(derived)).capabilities.hash).toBe(
      createRegistry(module(explicit)).capabilities.hash,
    )
  })

  test("publishes attribute requiredness from explicit and derived schemas", () => {
    const explicitAttributes = createRegistry(primitives).capabilities.components.find(
      (component) => component.tag === "DemoCard",
    )?.attributes
    const derivedAttributes = createRegistry(derivedPrimitives).capabilities.components.find(
      (component) => component.tag === "DerivedCard",
    )?.attributes

    expect(
      Object.fromEntries(
        (explicitAttributes ?? []).map((attribute) => [attribute.name, attribute.required]),
      ),
    ).toEqual({
      count: true,
      disabled: false,
      enabled: false,
      form: false,
      heading: true,
      "style-tokens": false,
      tone: false,
    })
    expect(
      Object.fromEntries(
        (derivedAttributes ?? []).map((attribute) => [attribute.name, attribute.required]),
      ),
    ).toEqual({
      "accessibility-label": false,
      disabled: false,
      heading: true,
      "original-price": true,
      tone: false,
    })
  })

  test("runs a JSON attribute schema once in a derived declaration", () => {
    const lengthCodec = jsonCodec(
      "derived-length",
      z.string().transform((value) => value.length),
      { maxBytes: 32 },
    )
    const transformed = defineComponent({
      attributes: {
        value: attr(lengthCodec),
      },
      children: "none",
      component: (props) => props.value,
      tag: "TransformedJson",
    })
    const registry = createRegistry(
      defineComponentModule({
        components: [transformed],
        name: "transformed-json",
        version: "1.0.0",
      }),
    )

    expect(lengthCodec.decode('"four"')).toBe(4)
    expect(registry.decode(element('<TransformedJson value="&quot;four&quot;" />')).props).toEqual({
      value: 4,
    })
  })

  test("infers a custom attribute schema's transformed output", () => {
    const transformed = defineComponent({
      attributes: {
        value: attr(
          trimmedStringCodec,
          z.string().transform((value) => value.length),
        ),
      },
      children: "none",
      component: (props) => props.value satisfies number,
      tag: "TransformedCustom",
    })
    const registry = createRegistry(
      defineComponentModule({
        components: [transformed],
        name: "transformed-custom",
        version: "1.0.0",
      }),
    )

    expect(registry.decode(element('<TransformedCustom value=" four " />')).props).toEqual({
      value: 4,
    })
  })

  test("preserves prototype-named wire attributes and rejects the reserved prop", () => {
    const prototypeAttribute = defineComponent({
      attributes: Object.fromEntries([
        ["__proto__", { codec: stringCodec, prop: "value" as const }],
      ]),
      children: "none",
      component: () => null,
      schema: z.object({ value: z.string() }),
      tag: "PrototypeAttribute",
    })
    const registry = createRegistry(
      defineComponentModule({
        components: [prototypeAttribute],
        name: "prototype-attribute",
        version: "1.0.0",
      }),
    )

    expect(Object.hasOwn(prototypeAttribute.attributeBindings, "__proto__")).toBe(true)
    expect(registry.decode(element('<PrototypeAttribute __proto__="safe" />')).props).toEqual({
      value: "safe",
    })
    expect(() =>
      defineComponent({
        attributes: {
          value: attr(stringCodec).prop("__proto__"),
        },
        children: "none",
        component: () => null,
        tag: "ReservedPrototypeProp",
      }),
    ).toThrow(/reserved prop "__proto__"/)
  })

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

  test("tolerates render vocabulary while keeping direct decode strict", () => {
    const registry = createRegistry(primitives)
    const resolve = registry.resolve.bind(registry)

    expect(() => registry.decode(element("<Unknown />"))).toThrow(RegistryError)
    const unknown = decodeRegistryElementForRender(
      resolve,
      element("<Unknown><DemoText>Fallback</DemoText></Unknown>"),
    )
    expect(unknown.status).toBe("transparent")
    if (unknown.status !== "transparent") throw new Error("unknown component did not unwrap")
    expect(unknown.children.filter(isElement)).toHaveLength(1)
    expect(unknown.issues).toEqual([{ kind: "component", tag: "Unknown" }])
    expect(Object.isFrozen(unknown)).toBe(true)
    expect(Object.isFrozen(unknown.issues)).toBe(true)
    expect(Object.isFrozen(unknown.issues[0])).toBe(true)

    const optional = decodeRegistryElementForRender(
      resolve,
      element(
        '<DemoCard surprise="x" heading="Hello" count="1" enabled="yes" data-state="ready" />',
      ),
    )
    expect(optional.status).toBe("decoded")
    if (optional.status !== "decoded") throw new Error("optional attribute did not decode")
    expect(optional.decoded.props).toMatchObject({ count: 1, enabled: true, title: "Hello" })
    expect(optional.decoded.protocol.data).toEqual({ state: "ready" })
    expect(optional.issues).toEqual([
      { attribute: "surprise", kind: "attribute", tag: "DemoCard" },
      { attribute: "enabled", kind: "attribute-decode", tag: "DemoCard" },
    ])

    const required = decodeRegistryElementForRender(
      resolve,
      element('<DemoCard heading="Hello" count="invalid"><DemoText>Fallback</DemoText></DemoCard>'),
    )
    expect(required.status).toBe("transparent")
    if (required.status !== "transparent") throw new Error("required attribute did not unwrap")
    expect(required.children.filter(isElement)).toHaveLength(1)
    expect(required.issues).toEqual([
      { attribute: "count", kind: "attribute-decode", tag: "DemoCard" },
    ])

    const refinedRequired = decodeRegistryElementForRender(
      resolve,
      element('<DemoCard heading="" count="1" />'),
    )
    expect(refinedRequired.status).toBe("transparent")
    expect(refinedRequired.issues).toEqual([
      { attribute: "heading", kind: "attribute-decode", tag: "DemoCard" },
    ])
    expect(() =>
      decodeRegistryElementForRender(resolve, element('<Unknown dir="sideways" />')),
    ).toThrow(PropsError)
  })

  test("classifies derived attribute schema failures per binding", () => {
    const refined = defineComponent({
      attributes: {
        optional: attr(stringCodec, z.string().min(1)).default("fallback"),
        required: attr(stringCodec, z.string().min(1)),
      },
      children: "nodes",
      component: () => null,
      tag: "Refined",
    })
    const registry = createRegistry(
      defineComponentModule({
        components: [refined],
        name: "refined",
        version: "1.0.0",
      }),
    )
    const resolve = registry.resolve.bind(registry)

    const optional = decodeRegistryElementForRender(
      resolve,
      element('<Refined optional="" required="ready" />'),
    )
    expect(optional.status).toBe("decoded")
    if (optional.status !== "decoded") throw new Error("optional refinement did not decode")
    expect(optional.decoded.props).toEqual({ optional: "fallback", required: "ready" })
    expect(optional.issues).toEqual([
      { attribute: "optional", kind: "attribute-decode", tag: "Refined" },
    ])

    const required = decodeRegistryElementForRender(
      resolve,
      element('<Refined required=""><DemoText>Fallback</DemoText></Refined>'),
    )
    expect(required.status).toBe("transparent")
    expect(required.issues).toEqual([
      { attribute: "required", kind: "attribute-decode", tag: "Refined" },
    ])
  })

  test("classifies explicit property schemas without rerunning transforms", () => {
    let transforms = 0
    const schema = z
      .object({
        optional: z.string().min(1).default("fallback"),
        required: z.string().min(1),
        transformed: z.string().transform((value) => {
          transforms += 1
          return value.length
        }),
      })
      .refine((props) => props.optional !== props.required)
    const explicit = defineComponent({
      attributes: {
        optional: { codec: stringCodec, prop: "optional" },
        required: { codec: stringCodec, prop: "required" },
        transformed: { codec: stringCodec, prop: "transformed" },
      },
      children: "none",
      component: () => null,
      schema,
      tag: "ExplicitRefined",
    })
    const registry = createRegistry(
      defineComponentModule({
        components: [explicit],
        name: "explicit-refined",
        version: "1.0.0",
      }),
    )
    const resolve = registry.resolve.bind(registry)

    const optional = decodeRegistryElementForRender(
      resolve,
      element('<ExplicitRefined optional="" required="ready" transformed="four" />'),
    )
    expect(optional.status).toBe("decoded")
    if (optional.status !== "decoded") throw new Error("explicit optional did not decode")
    expect(optional.decoded.props).toEqual({
      optional: "fallback",
      required: "ready",
      transformed: 4,
    })
    expect(optional.issues).toEqual([
      { attribute: "optional", kind: "attribute-decode", tag: "ExplicitRefined" },
    ])
    expect(transforms).toBe(1)

    const required = decodeRegistryElementForRender(
      resolve,
      element('<ExplicitRefined required="" transformed="five" />'),
    )
    expect(required.status).toBe("transparent")
    expect(required.issues).toEqual([
      { attribute: "required", kind: "attribute-decode", tag: "ExplicitRefined" },
    ])

    // A cross-field rejection means the served markup no longer satisfies this
    // installed contract, so the node unwraps instead of failing the document.
    const crossField = decodeRegistryElementForRender(
      resolve,
      element('<ExplicitRefined optional="same" required="same" transformed="three" />'),
    )
    expect(crossField.status).toBe("transparent")
    expect(crossField.issues).toEqual([{ kind: "component", tag: "ExplicitRefined" }])
    expect(() =>
      registry.decode(
        element('<ExplicitRefined optional="same" required="same" transformed="three" />'),
      ),
    ).toThrow(PropsError)
  })

  test("unwraps a node whose props or child slots no longer match the markup", () => {
    const registry = createRegistry(primitives)
    const resolve = registry.resolve.bind(registry)

    // A required attribute the server stopped sending is ordinary skew.
    const missing = decodeRegistryElementForRender(
      resolve,
      element('<DemoCard heading="Hello"><DemoText>Fallback</DemoText></DemoCard>'),
    )
    expect(missing.status).toBe("transparent")
    expect(missing.issues).toEqual([{ kind: "component", tag: "DemoCard" }])
    expect(() => registry.decode(element('<DemoCard heading="Hello" />'))).toThrow(PropsError)

    // The issue's fallback channel: new vocabulary nested inside a text-only
    // component must degrade instead of failing the document.
    const textSlot = decodeRegistryElementForRender(
      resolve,
      element("<DemoText>hi <FutureEm>there</FutureEm></DemoText>"),
    )
    expect(textSlot.status).toBe("transparent")
    expect(textSlot.issues).toEqual([{ kind: "component", tag: "DemoText" }])
    expect(() => registry.decode(element("<DemoText><DemoCard /></DemoText>"))).toThrow(PropsError)

    // Invalid shared protocol values stay fatal on both paths.
    expect(() =>
      decodeRegistryElementForRender(
        resolve,
        element('<DemoCard heading="Hello" dir="sideways" />'),
      ),
    ).toThrow(PropsError)
  })

  test("defaults missing and invalid prototype-named derived props", () => {
    const prototypeProps = defineComponent({
      attributes: {
        constructor: attr(integerCodec).default(7),
        toString: attr(stringCodec).default("safe"),
      },
      children: "none",
      component: () => null,
      tag: "PrototypeProps",
    })
    const registry = createRegistry(
      defineComponentModule({
        components: [prototypeProps],
        name: "prototype-props",
        version: "1.0.0",
      }),
    )
    const resolve = registry.resolve.bind(registry)

    expect(registry.decode(element("<PrototypeProps />")).props).toEqual({
      constructor: 7,
      toString: "safe",
    })
    const rendered = decodeRegistryElementForRender(
      resolve,
      element('<PrototypeProps constructor="bad" />'),
    )
    expect(rendered.status).toBe("decoded")
    if (rendered.status !== "decoded") throw new Error("prototype props did not decode")
    expect(rendered.decoded.props).toEqual({ constructor: 7, toString: "safe" })
    expect(rendered.issues).toEqual([
      { attribute: "constructor", kind: "attribute-decode", tag: "PrototypeProps" },
    ])
  })

  test("keeps legacy bindings without requiredness eligible for defaults", () => {
    const legacy: RegistryComponent = {
      aliases: [],
      attributeBindings: {
        count: { codec: integerCodec, prop: "count" },
      },
      children: "none",
      component: () => null,
      decodeProps: (attributes) => ({ count: attributes.count ?? 5 }),
      formOwner: false,
      morphState: "preserve",
      tag: "LegacyDefault",
    }
    const registry = createRegistry(
      defineComponentModule({
        components: [legacy],
        name: "legacy-default",
        version: "1.0.0",
      }),
    )
    const rendered = registry.decodeForRender(element('<LegacyDefault count="bad" />'))

    expect(rendered.status).toBe("decoded")
    if (rendered.status !== "decoded") throw new Error("legacy default did not decode")
    expect(rendered.decoded.props).toEqual({ count: 5 })
    expect(rendered.issues).toEqual([
      { attribute: "count", kind: "attribute-decode", tag: "LegacyDefault" },
    ])
  })

  test("admits package-owned attributes only on form owners", () => {
    const owner = defineComponent({
      attributes: {},
      children: "nodes",
      component: () => null,
      formOwner: true,
      schema: z.object({}),
      tag: "DemoForm",
    })
    const registry = createRegistry(
      defineComponentModule({
        components: [owner],
        name: "form-owner",
        version: "1.0.0",
      }),
    )
    const form = element(
      '<DemoForm action="/submit" enctype="multipart/form-data" method="post" novalidate="" target="frame" />',
    )

    expect(registry.decode(form).props).toEqual({})
    const rendered = decodeRegistryElementForRender(registry.resolve.bind(registry), form)
    expect(rendered.status).toBe("decoded")
    expect(rendered.issues).toEqual([])
    expect(registry.capabilities.components[0]?.attributes).toEqual([])

    expect(() =>
      createRegistry(primitives).decode(
        element('<DemoCard heading="Hello" count="1" action="/submit" />'),
      ),
    ).toThrow(PropsError)
  })

  test("leaves an unknown form-owner tag without a definition to probe", () => {
    const owner = defineComponent({
      attributes: { required: attr(integerCodec) },
      children: "nodes",
      component: () => null,
      formOwner: true,
      tag: "DemoForm",
    })
    const registry = createRegistry(
      defineComponentModule({
        components: [owner],
        name: "form-owner-lookup",
        version: "1.0.0",
      }),
    )

    // Form association resolves an owner definition through `resolve` first and
    // falls back to the render decode path. An unknown tag misses both, so the
    // association has only the reported vocabulary issue to go on.
    const unknown = registry.decodeForRender(element('<FutureForm id="form" />'))
    expect(registry.resolve("FutureForm")).toBeUndefined()
    expect(unknown.status).toBe("transparent")
    if (unknown.status !== "transparent") throw new Error("unknown form owner did not unwrap")
    expect(unknown.definition).toBeUndefined()
    expect(unknown.issues).toEqual([{ kind: "component", tag: "FutureForm" }])

    // A known owner reports its own unknown attributes on the decoded path, so
    // an association can report an owner the document never renders.
    const decoded = registry.decodeForRender(
      element('<DemoForm id="form" required="1" future-layout="stacked" />'),
    )
    expect(decoded.status).toBe("decoded")
    if (decoded.status !== "decoded") throw new Error("known form owner did not decode")
    expect(decoded.decoded.definition.formOwner).toBe(true)
    expect(decoded.issues).toEqual([
      { attribute: "future-layout", kind: "attribute", tag: "DemoForm" },
    ])

    // A known owner keeps its definition on the transparent path, so a required
    // attribute failure still resolves as a declared form owner.
    const degraded = registry.decodeForRender(element('<DemoForm id="form" required="bad" />'))
    expect(degraded.status).toBe("transparent")
    if (degraded.status !== "transparent") throw new Error("degraded form owner did not unwrap")
    expect(degraded.definition?.formOwner).toBe(true)
    expect(degraded.issues).toEqual([
      { attribute: "required", kind: "attribute-decode", tag: "DemoForm" },
    ])
  })

  test("treats inherited binding names as unknown render attributes", () => {
    const registry = createRegistry(primitives)
    const rendered = decodeRegistryElementForRender(
      registry.resolve.bind(registry),
      element('<DemoCard heading="Hello" count="1" constructor="x" toString="y" />'),
    )

    expect(rendered.status).toBe("decoded")
    expect(rendered.issues).toEqual([
      { attribute: "constructor", kind: "attribute", tag: "DemoCard" },
      { attribute: "toString", kind: "attribute", tag: "DemoCard" },
    ])
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

    const aliasCollision = defineComponentModule({
      components: [
        defineComponent({
          aliases: ["B"],
          attributes: {},
          children: "none",
          component: () => null,
          schema: z.object({}),
          tag: "A",
        }),
        defineComponent({
          attributes: {},
          children: "none",
          component: () => null,
          schema: z.object({}),
          tag: "B",
        }),
      ],
      name: "probe",
      version: "0.1.0",
    })
    expect(() => createRegistry(aliasCollision)).toThrow(
      'Component name "B" is declared more than once in component module "probe"',
    )
  })

  test("generates the runtime manifest from component-free definitions", () => {
    const runtime = createRegistry(derivedPrimitives)
    const manifest = createCapabilityManifest(derivedCapabilities)

    expect("component" in derivedCardDefinition).toBe(false)
    expect(Object.isFrozen(derivedCardDefinition)).toBe(true)
    expect(Object.isFrozen(derivedCapabilities.components)).toBe(true)
    expect(manifest).toEqual(runtime.capabilities)
    expect(capabilityManifestJSON(derivedCapabilities)).toBe(runtime.capabilityManifestJSON())
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
    expect(first.capabilities.manifestVersion).toBe(2)
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
    expect(JSON.parse(first.capabilityManifestJSON())).toEqual(first.capabilities)
    expect(first.capabilityManifestJSON()).toEndWith("\n")
    expect(first.capabilityManifestJSON()).toBe(second.capabilityManifestJSON())
  })

  test("uses locale-independent manifest ordering", () => {
    const composed = defineComponent({
      attributes: {},
      children: "none",
      component: () => null,
      schema: z.object({}),
      tag: "Orderé",
    })
    const decomposed = defineComponent({
      attributes: {},
      children: "none",
      component: () => null,
      schema: z.object({}),
      tag: "Ordere\u0301",
    })
    const composedModule = defineComponentModule({
      components: [composed],
      name: "Moduleé",
      version: "1.0.0",
    })
    const decomposedModule = defineComponentModule({
      components: [decomposed],
      name: "Modulee\u0301",
      version: "1.0.0",
    })

    const first = createRegistry(composedModule, decomposedModule)
    const second = createRegistry(decomposedModule, composedModule)

    expect(first.capabilityManifestJSON()).toBe(second.capabilityManifestJSON())
    expect(first.capabilities.hash).toBe(second.capabilities.hash)
  })
})

function acceptRegistryShapes(): void {
  const component: RegistryComponent = {
    aliases: [],
    attributeBindings: {
      title: { codec: stringCodec, prop: "title" },
    },
    children: "none",
    component: () => null,
    decodeProps: (attributes) => attributes,
    formOwner: false,
    morphState: "preserve",
    tag: "LegacyComponent",
  }
  const capabilities: RegistryCapabilityManifest = {
    components: [],
    hash: "fnv1a32:00000000",
    modules: [],
    protocolVersion: "1.0",
  }
  const registry: ComponentRegistry<RegistryComponent> = {
    capabilities,
    decode() {
      throw new Error("not used")
    },
    decodeForRender() {
      throw new Error("not used")
    },
    formContainerRole() {
      return undefined
    },
    get() {
      return undefined
    },
    resolve() {
      return undefined
    },
    use() {
      throw new Error("not used")
    },
  }
  const { decodeForRender, ...decodeOnly } = registry
  // @ts-expect-error Provider registries require tolerant render decoding.
  const invalid: ComponentRegistry<RegistryComponent> = decodeOnly
  void component
  void decodeForRender
  void invalid
  void registry
}
void acceptRegistryShapes

function rejectMismatchedAttributeSchema(): void {
  // @ts-expect-error Attribute schema input must accept the codec decode value.
  attr(stringCodec, z.number())
  attr(
    stringCodec,
    // @ts-expect-error Attribute schema input must accept the codec decode value.
    z.number().transform((value) => String(value)),
  )
}
void rejectMismatchedAttributeSchema
