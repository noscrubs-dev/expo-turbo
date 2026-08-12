import { expect, mock, test } from "bun:test"
import { isElement, parseExpoTurboDocument } from "expo-turbo/core"

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

const { DEMO_REGISTRY } = await import("./demo-registry")

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
