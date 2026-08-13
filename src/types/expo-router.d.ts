declare module "expo-router" {
  export interface ExpoTurboImperativeRouter {
    back(): void
    canGoBack(): boolean
    push(
      href:
        | string
        | Readonly<{
            params?: Readonly<
              Record<string, (string | number)[] | null | number | string | undefined>
            >
            pathname: string
          }>,
    ): void
    replace(
      href:
        | string
        | Readonly<{
            params?: Readonly<
              Record<string, (string | number)[] | null | number | string | undefined>
            >
            pathname: string
          }>,
    ): void
  }

  export function useRouter(): ExpoTurboImperativeRouter

  export function usePathname(): string

  /**
   * Expo Router marks this private. It reserves the right to start returning an
   * absolute URL with a hostname, so callers must keep only the path portion,
   * and it may be renamed or removed outright — hence the optional type, which
   * forces every caller to select it defensively rather than import it
   * statically.
   */
  export const useUnstableGlobalHref: (() => string) | undefined
}
