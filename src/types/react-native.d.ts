/**
 * Minimal ambient surface for the optional `react-native` peer, mirroring the
 * existing `expo-router` declaration. It exists so the package typechecks
 * without installing React Native at the repository root; it is never emitted,
 * so consumers resolve the real React Native types.
 */
declare module "react-native" {
  import type { ComponentType, ReactNode, Ref } from "react"

  export type ExpoTurboNativeStyle = Readonly<
    Record<string, number | string | readonly unknown[] | undefined>
  >

  export interface ExpoTurboNativeViewProps {
    readonly accessibilityLabel?: string
    readonly accessibilityRole?: string
    readonly accessible?: boolean
    readonly children?: ReactNode
    readonly collapsable?: boolean
    readonly onPress?: () => void
    readonly ref?: Ref<unknown>
    readonly role?: string
    readonly selectable?: boolean
    readonly style?: ExpoTurboNativeStyle | readonly (ExpoTurboNativeStyle | false | undefined)[]
    readonly testID?: string
  }

  export interface ExpoTurboNativeActivityIndicatorProps {
    readonly accessibilityLabel?: string
    readonly color?: string
    readonly size?: "large" | "small"
  }

  export const ActivityIndicator: ComponentType<ExpoTurboNativeActivityIndicatorProps>
  export const Pressable: ComponentType<ExpoTurboNativeViewProps>
  export const Text: ComponentType<ExpoTurboNativeViewProps>
  export const View: ComponentType<ExpoTurboNativeViewProps>

  export const AccessibilityInfo: {
    announceForAccessibility(announcement: string): void
  }
  export const I18nManager: {
    readonly isRTL?: boolean
  }
  export const Linking: {
    openURL(url: string): Promise<unknown>
  }
}
