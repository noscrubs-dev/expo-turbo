import { createElement, type ReactNode } from "react"
import { ActivityIndicator, Pressable, Text, View } from "react-native"

/**
 * React Native defines `__DEV__` as a global; reading it off `globalThis`
 * keeps this module loadable under plain Node and Bun, where it is absent.
 */
export function isDevelopmentBuild(): boolean {
  return (globalThis as { __DEV__?: boolean }).__DEV__ === true
}

const CONTAINER = Object.freeze({
  alignItems: "center",
  flexGrow: 1,
  gap: 12,
  justifyContent: "center",
  padding: 24,
})

/**
 * The default still-loading treatment. `ExpoTurbo` on its own renders nothing
 * while a document loads, which made "loading", "misconfigured", and "failed"
 * the same blank screen.
 */
export function ExpoTurboLoadingSurface(): ReactNode {
  return createElement(
    View,
    { style: CONTAINER, testID: "expo-turbo-loading" },
    createElement(ActivityIndicator, {
      accessibilityLabel: "Loading",
      size: "large",
    }),
  )
}

/**
 * The packaged text primitive, wrapped around every text run the renderer
 * places itself — the surviving text of an unwrapped unknown element, most
 * often. Without a primitive such a run is dropped, because a bare string
 * under a `View` breaks React Native's text-in-view rule.
 *
 * It carries no styling of its own so it inherits the surrounding text style,
 * which is what makes text from a tag this build does not know read like the
 * text around it rather than like a separate widget.
 */
export function ExpoTurboTextSurface({ children }: Readonly<{ children?: ReactNode }>): ReactNode {
  return createElement(Text, { selectable: true }, children)
}

export interface ExpoTurboErrorSurfaceProps {
  readonly error: Error
  readonly retry: () => void
}

/**
 * The default hard-failure treatment.
 *
 * Development builds print the real `name: message` because that is the only
 * audience that can act on `ContentTypeError` or `RequestError`. Release
 * builds print one fixed sentence instead: package errors are already
 * redacted, but they are diagnostics rather than copy, and showing them to an
 * end user trades a blank screen for an incomprehensible one. The real error
 * always reaches `onError` in both builds, so telemetry loses nothing.
 */
export function ExpoTurboErrorSurface({ error, retry }: ExpoTurboErrorSurfaceProps): ReactNode {
  const detail = isDevelopmentBuild()
    ? `${error.name}: ${error.message}`
    : "This screen could not be loaded."

  return createElement(
    View,
    {
      accessibilityLabel: `Screen failed to load. ${detail}`,
      accessible: true,
      role: "alert",
      style: CONTAINER,
      testID: "expo-turbo-error",
    },
    createElement(
      Text,
      { selectable: true, style: { fontSize: 16, fontWeight: "600", textAlign: "center" } },
      "Something went wrong",
    ),
    createElement(
      Text,
      {
        selectable: true,
        style: { color: "#59636e", fontSize: 14, textAlign: "center" },
        testID: "expo-turbo-error-detail",
      },
      detail,
    ),
    createElement(
      Pressable,
      {
        accessibilityRole: "button",
        onPress: retry,
        style: {
          backgroundColor: "#285589",
          borderRadius: 10,
          paddingHorizontal: 16,
          paddingVertical: 10,
        },
        testID: "expo-turbo-error-retry",
      },
      createElement(Text, { style: { color: "white", fontWeight: "600" } }, "Try again"),
    ),
  )
}
