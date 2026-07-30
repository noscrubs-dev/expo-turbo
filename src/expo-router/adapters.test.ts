import { describe, expect, test } from "bun:test"

import { StateError } from "../core/errors"
import {
  createExpoRouterAdapters,
  defaultExpoRouterHrefForDocument,
  type ExpoRouterAdapterHost,
  type ExpoRouterHref,
} from "./adapters"

class Router implements ExpoRouterAdapterHost {
  canGoBackValue = true
  readonly calls: Array<Readonly<{ href?: ExpoRouterHref; method: string }>> = []

  back(): void {
    this.calls.push({ method: "back" })
  }

  canGoBack(): boolean {
    return this.canGoBackValue
  }

  push(href: ExpoRouterHref): void {
    this.calls.push({ href, method: "push" })
  }

  replace(href: ExpoRouterHref): void {
    this.calls.push({ href, method: "replace" })
  }
}

describe("Expo Router adapters", () => {
  test("maps document navigation, external URLs, and restores to Expo Router", () => {
    const router = new Router()
    const adapters = createExpoRouterAdapters(router)

    adapters.navigation.visit("https://example.test/orders?state=open#today", "advance")
    adapters.navigation.visit("https://example.test/orders/1", "replace")
    adapters.navigation.openExternal("https://outside.test/help")
    adapters.navigation.visit("https://example.test/orders", "restore")
    adapters.navigation.back()

    expect(router.calls).toEqual([
      { href: "/orders?state=open#today", method: "push" },
      { href: "/orders/1", method: "replace" },
      { href: "https://outside.test/help", method: "push" },
      { method: "back" },
      { method: "back" },
    ])
    expect(Object.isFrozen(adapters)).toBe(true)
    expect(Object.isFrozen(adapters.navigation)).toBe(true)
    expect(Object.isFrozen(adapters.history)).toBe(true)
  })

  test("maps history writes synchronously and supports a custom route space", () => {
    const router = new Router()
    const adapters = createExpoRouterAdapters(router, {
      hrefForDocument(url) {
        return {
          params: { documentUrl: url },
          pathname: "/documents/[documentUrl]",
        }
      },
    })
    const entry = {
      restorationIdentifier: "restoration-1",
      restorationIndex: 0,
      url: "https://example.test/orders/1?tab=details",
    }

    expect(adapters.history.write("replace", entry)).toBeUndefined()
    expect(adapters.history.write("push", { ...entry, restorationIndex: 1 })).toBeUndefined()
    expect(router.calls).toEqual([
      {
        href: {
          params: { documentUrl: entry.url },
          pathname: "/documents/[documentUrl]",
        },
        method: "replace",
      },
      {
        href: {
          params: { documentUrl: entry.url },
          pathname: "/documents/[documentUrl]",
        },
        method: "push",
      },
    ])
  })

  test("validates default document URLs and mapper results before router writes", () => {
    expect(defaultExpoRouterHrefForDocument("https://example.test/")).toBe("/")
    expect(() => defaultExpoRouterHrefForDocument("/relative")).toThrow(StateError)
    expect(() => defaultExpoRouterHrefForDocument("mailto:test@example.test")).toThrow(StateError)
    expect(() =>
      defaultExpoRouterHrefForDocument("https://example.test//outside.test/path"),
    ).toThrow(new StateError("Expo Router document URL must map to an internal path"))
    expect(() =>
      createExpoRouterAdapters(new Router(), {
        hrefForDocument: () => "",
      }).navigation.visit("https://example.test/", "advance"),
    ).toThrow(StateError)
  })

  test("fails closed when back is unavailable or a router write is not synchronous", () => {
    const router = new Router()
    router.canGoBackValue = false
    expect(() => createExpoRouterAdapters(router).navigation.back()).toThrow(
      new StateError("Expo Router back failed"),
    )

    const asynchronous = new Router() as Router & {
      push(href: ExpoRouterHref): Promise<void>
    }
    asynchronous.push = async () => undefined
    expect(() =>
      createExpoRouterAdapters(asynchronous as ExpoRouterAdapterHost).history.write("push", {
        restorationIdentifier: "restoration-1",
        restorationIndex: 1,
        url: "https://example.test/next",
      }),
    ).toThrow(new StateError("Expo Router history write failed"))
  })
})
