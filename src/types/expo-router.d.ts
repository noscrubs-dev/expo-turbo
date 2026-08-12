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
   * Expo Router marks this private and reserves the right to start returning an
   * absolute URL with a hostname. Callers must keep only the path portion.
   */
  export function useUnstableGlobalHref(): string
}
