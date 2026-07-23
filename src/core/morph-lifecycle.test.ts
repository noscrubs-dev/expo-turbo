import { describe, expect, test } from "bun:test"

import { MorphLifecycle } from "./morph-lifecycle"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { dispatchTurboStreamFragment } from "./streams"
import { attributeValue, morphCurrentDocumentRoot, morphFrameRefreshChildren } from "./tree"

function session(xml: string, lifecycle: MorphLifecycle): DocumentSession {
  return new DocumentSession(parseExpoTurboDocument(xml, { url: "https://example.test/one" }), {
    morphLifecycle: lifecycle,
  })
}

describe("morph lifecycle", () => {
  test("validates nominal lifecycle ownership and uses stable listener snapshots", async () => {
    expect(() => new MorphLifecycle({ onObserverError: "invalid" as never })).toThrow()
    expect(
      () =>
        new DocumentSession(parseExpoTurboDocument("<Gallery />"), {
          morphLifecycle: {} as MorphLifecycle,
        }),
    ).toThrow()

    const lifecycle = new MorphLifecycle()
    const calls: string[] = []
    let unsubscribeSecond: () => void = () => undefined
    lifecycle.subscribe("before-morph-element", () => {
      calls.push("first")
      unsubscribeSecond()
      lifecycle.subscribe("before-morph-element", () => {
        calls.push("late")
        return undefined
      })
      return undefined
    })
    unsubscribeSecond = lifecycle.subscribe("before-morph-element", () => {
      calls.push("second")
      return undefined
    })
    const document = session('<Gallery id="gallery"><Item id="item" /></Gallery>', lifecycle)
    await dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="update" target="gallery" method="morph"><template><Item id="item" /></template></turbo-stream>',
    )
    expect(calls).toEqual(["first", "second"])
  })

  test("vetoes matched elements, attribute changes, and removals while notifying committed elements", async () => {
    const lifecycle = new MorphLifecycle()
    const events: string[] = []
    lifecycle.subscribe("before-morph-element", (event) => {
      const id = attributeValue(event.detail.currentElement, "id")
      events.push(`before:${id}`)
      expect(Object.isFrozen(event)).toBe(true)
      expect(Object.isFrozen(event.detail)).toBe(true)
      if (id === "blocked" || id === "gone" || id === "middle" || id === "tail") {
        event.preventDefault()
      }
      return undefined
    })
    lifecycle.subscribe("before-morph-attribute", (event) => {
      events.push(`${event.detail.mutationType}:${event.detail.attributeName}`)
      if (event.detail.attributeName === "retained") event.preventDefault()
      return undefined
    })
    lifecycle.subscribe("morph-element", (event) => {
      events.push(`after:${attributeValue(event.detail.currentElement, "id")}`)
      return undefined
    })

    const document = session(
      '<Gallery id="gallery"><Gone id="gone" /><Item id="item" value="old" retained="yes"><Child id="child" /></Item><Middle id="middle" /><Blocked id="blocked"><Old /></Blocked><Tail id="tail" /></Gallery>',
      lifecycle,
    )
    const report = (
      await dispatchTurboStreamFragment(
        document,
        '<turbo-stream action="update" target="gallery" method="morph"><template><Item id="item" value="new" added="yes"><Child id="child" /></Item><Blocked id="blocked"><New /></Blocked></template></turbo-stream>',
      )
    ).actions[0]

    expect(report?.status).toBe("applied")
    const item = document.tree.getElementById("item")
    expect(item && attributeValue(item, "value")).toBe("new")
    expect(item && attributeValue(item, "added")).toBe("yes")
    expect(item && attributeValue(item, "retained")).toBe("yes")
    expect(document.tree.getElementById("gone")).toBeDefined()
    expect(document.tree.getElementById("blocked")?.children[0]).toMatchObject({ tagName: "Old" })
    expect(
      document.tree.getElementById("gallery")?.children.flatMap((child) => {
        if (child.kind !== "element") return []
        const id = attributeValue(child, "id")
        return id ? [id] : []
      }),
    ).toEqual(["gone", "item", "middle", "blocked", "tail"])
    expect(events).toEqual([
      "before:item",
      "remove:retained",
      "update:value",
      "update:added",
      "before:child",
      "before:blocked",
      "before:gone",
      "before:middle",
      "before:tail",
      "after:child",
      "after:item",
    ])
  })

  test("shares the lifecycle across Frame and current-document morph entrypoints", async () => {
    const lifecycle = new MorphLifecycle()
    const seen: string[] = []
    lifecycle.subscribe("before-morph-element", (event) => {
      seen.push(`before:${attributeValue(event.detail.currentElement, "id")}`)
      return undefined
    })
    lifecycle.subscribe("morph-element", (event) => {
      seen.push(`after:${attributeValue(event.detail.currentElement, "id")}`)
      return undefined
    })
    const document = session(
      '<Gallery id="root"><turbo-frame id="details"><Card id="card" /></turbo-frame><Aside id="aside" /></Gallery>',
      lifecycle,
    )
    const frame = document.tree.getElementById("details")
    const incomingFrame = parseExpoTurboDocument(
      '<Gallery><turbo-frame id="details"><Card id="card" tone="new" /></turbo-frame></Gallery>',
    ).getElementById("details")
    if (frame?.kind !== "frame" || incomingFrame?.kind !== "frame") throw new Error("fixture")
    document.mutate((tree) => morphFrameRefreshChildren(tree, frame, incomingFrame).changed)

    const page = session('<Gallery id="root"><Aside id="aside" /></Gallery>', lifecycle)
    const source = parseExpoTurboDocument(
      '<Gallery id="root"><Aside id="aside" tone="new" /></Gallery>',
      { url: "https://example.test/two" },
    )
    page.mutate((tree) => morphCurrentDocumentRoot(tree, source).changed)

    expect(seen).toEqual([
      "before:card",
      "after:card",
      "before:root",
      "before:aside",
      "after:aside",
      "after:root",
    ])
  })

  test("treats an incompatible document root as a replacement around retained descendants", () => {
    const lifecycle = new MorphLifecycle()
    const seen: string[] = []
    lifecycle.subscribe("before-morph-element", (event) => {
      const id = attributeValue(event.detail.currentElement, "id")
      seen.push(
        `before:${id}:${event.detail.newElement ? attributeValue(event.detail.newElement, "id") : "removed"}`,
      )
      return undefined
    })
    lifecycle.subscribe("morph-element", (event) => {
      seen.push(`after:${attributeValue(event.detail.currentElement, "id")}`)
      return undefined
    })
    const document = session(
      '<Gallery id="gallery"><Group id="left"><Field id="field" tone="before"/></Group></Gallery>',
      lifecycle,
    )
    const root = document.tree.getElementById("gallery")
    const field = document.tree.getElementById("field")
    const source = parseExpoTurboDocument(
      '<Screen id="screen"><Group id="right"><Field id="field" tone="after"/></Group></Screen>',
      { url: "https://example.test/two" },
    )

    document.mutate((tree) => morphCurrentDocumentRoot(tree, source).changed)

    expect(document.tree.getElementById("screen")).not.toBe(root)
    expect(document.tree.getElementById("field")).toBe(field)
    expect(seen).toEqual([
      "before:gallery:removed",
      "before:field:field",
      "before:left:removed",
      "after:field",
    ])
  })

  test("notifies one retained stable identity once when it changes parents", async () => {
    const lifecycle = new MorphLifecycle()
    const fieldEvents: string[] = []
    lifecycle.subscribe("before-morph-element", (event) => {
      if (attributeValue(event.detail.currentElement, "id") === "field") {
        fieldEvents.push("before")
      }
      return undefined
    })
    lifecycle.subscribe("morph-element", (event) => {
      if (attributeValue(event.detail.currentElement, "id") === "field") {
        fieldEvents.push("after")
      }
      return undefined
    })
    const document = session(
      '<Gallery id="gallery"><Group id="right"/><Group id="left"><Field id="field"/></Group></Gallery>',
      lifecycle,
    )

    await dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="update" target="gallery" method="morph"><template><Group id="right"><Field id="field"/></Group><Group id="left"/></template></turbo-stream>',
    )

    expect(fieldEvents).toEqual(["before", "after"])
    expect(document.tree.getElementById("field")?.parent).toBe(
      document.tree.getElementById("right"),
    )
  })

  test("keeps permanent moves opaque and silent while notifying retained descendants", async () => {
    const lifecycle = new MorphLifecycle()
    const events: string[] = []
    lifecycle.subscribe("before-morph-element", (event) => {
      events.push(`before:${attributeValue(event.detail.currentElement, "id")}`)
      return undefined
    })
    lifecycle.subscribe("morph-element", (event) => {
      events.push(`after:${attributeValue(event.detail.currentElement, "id")}`)
      return undefined
    })
    const document = session(
      '<Gallery id="gallery"><Group id="left"><Panel id="permanent" data-turbo-permanent=""/><turbo-frame id="permanent-frame" data-turbo-permanent=""><ClientOwned id="frame-child"/></turbo-frame></Group><Old id="wrapper"><Field id="field"/></Old><Group id="right"/></Gallery>',
      lifecycle,
    )

    await dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="update" target="gallery" method="morph"><template><Group id="left"/><New id="wrapper"><Field id="field" tone="after"/></New><Group id="right"><Panel id="permanent"/><turbo-frame id="permanent-frame"><ServerOwned id="ignored"/></turbo-frame></Group></template></turbo-stream>',
    )

    expect(document.tree.getElementById("permanent")?.parent).toBe(
      document.tree.getElementById("right"),
    )
    expect(document.tree.getElementById("permanent-frame")?.parent).toBe(
      document.tree.getElementById("right"),
    )
    expect(document.tree.getElementById("frame-child")).toBeDefined()
    expect(document.tree.getElementById("ignored")).toBeUndefined()
    expect(events.filter((event) => event.endsWith(":permanent"))).toEqual([])
    expect(events.filter((event) => event.endsWith(":permanent-frame"))).toEqual([])
    expect(events.filter((event) => event.endsWith(":frame-child"))).toEqual([])
    expect(events.filter((event) => event.endsWith(":field"))).toEqual([
      "before:field",
      "after:field",
    ])
  })

  test("rejects reentrant session mutation from a cancellable listener without committing", async () => {
    const lifecycle = new MorphLifecycle()
    const document = session(
      '<Gallery id="gallery"><Item id="item" value="old" /></Gallery>',
      lifecycle,
    )
    lifecycle.subscribe("before-morph-element", () => {
      document.setAttribute("id:item", "value", "reentrant")
      return undefined
    })

    const report = (
      await dispatchTurboStreamFragment(
        document,
        '<turbo-stream action="update" target="gallery" method="morph"><template><Item id="item" value="new" /></template></turbo-stream>',
      )
    ).actions[0]

    expect(report?.status).toBe("error")
    const item = document.tree.getElementById("item")
    expect(item && attributeValue(item, "value")).toBe("old")
    expect(document.revision).toBe(0)
  })
})
