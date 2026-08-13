import { expect, mock, test } from "bun:test"
import { isElement, parseExpoTurboDocument } from "expo-turbo/core"
import { component, defineRegistry, none } from "expo-turbo/registry"
import { memo } from "react"

const nativeComponent = () => null

mock.module("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Alert: { alert: () => undefined },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  FlatList: nativeComponent,
  InteractionManager: {
    runAfterInteractions(callback: () => void) {
      callback()
      return { cancel: () => undefined }
    },
  },
  Keyboard: { addListener: () => ({ remove: () => undefined }), dismiss: () => undefined },
  Linking: { openURL: async () => undefined },
  Platform: { OS: "web" },
  Pressable: nativeComponent,
  ScrollView: nativeComponent,
  Switch: nativeComponent,
  Text: nativeComponent,
  TextInput: nativeComponent,
  useWindowDimensions: () => ({ height: 844, width: 390 }),
  View: nativeComponent,
}))

const { DEMO_MODULE_VERSIONS, DEMO_REGISTRY } = await import("./demo-registry")

test("the example registry keeps its server negotiation identity", () => {
  expect(DEMO_REGISTRY.capabilities.modules).toEqual([{ name: "expo-turbo-example" }])
  expect(DEMO_MODULE_VERSIONS).toMatch(
    /^v=1; proto=0\.1; rt=0\.3\.0; vocab=sha256-128:[0-9a-f]{32}$/,
  )
  expect(DEMO_REGISTRY.capabilities.hash).toBe("sha256-128:f04ab2d6529c683a1094a0b8ddc8d5ea")
})

// The Rails demo serves /api/expo_turbo/demo/shared_greeting from one
// template, which spells DemoText as the HTML element a browser understands.
// The host admits `p` through the alias it declares; without the same alias
// here the device receives markup it cannot draw.
test("the example registry renders the HTML element name the shared Rails template writes", () => {
  const shared = parseExpoTurboDocument(
    '<p id="demo-shared-greeting-text">One template, two audiences</p>',
  ).document.children.find(isElement)
  if (!shared) throw new Error("fixture lost its root element")

  expect(DEMO_REGISTRY.resolve("p")).toBe(DEMO_REGISTRY.resolve("DemoText"))
  expect(() => DEMO_REGISTRY.decodeForRender(shared)).not.toThrow()
})

test("the example registry throws for an unregistered component in development", () => {
  const development = globalThis as typeof globalThis & { __DEV__?: boolean }
  const previous = development.__DEV__
  development.__DEV__ = true
  try {
    const unknown = parseExpoTurboDocument("<UnregisteredDemo />").document.children.find(isElement)
    if (!unknown) throw new Error("fixture lost its root element")

    expect(DEMO_REGISTRY.resolve("UnregisteredDemo")).toBeUndefined()
    expect(() => DEMO_REGISTRY.decodeForRender(unknown)).toThrow(
      /Unknown component "UnregisteredDemo"/,
    )
  } finally {
    if (previous === undefined) delete development.__DEV__
    else development.__DEV__ = previous
  }
})

test("the registry gives one memo renderer a stable keyed wrapper without changing it", () => {
  const render = memo(() => null)
  render.displayName = "LibraryMemo"
  const registry = defineRegistry({
    module: { name: "memo-probe", version: "0.1.0" },
    components: {
      StableMemoTag: component({ children: none, render }),
    },
  })

  const first = registry.resolve("StableMemoTag")?.component
  expect(first).toBe(registry.resolve("StableMemoTag")?.component)
  expect(first).not.toBe(render)
  expect(first).toHaveProperty("displayName", "StableMemoTag")
  expect(render.displayName).toBe("LibraryMemo")
  expect(registry.resolve("LibraryMemo")).toBeUndefined()
})
