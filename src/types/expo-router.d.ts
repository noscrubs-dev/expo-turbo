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
}
