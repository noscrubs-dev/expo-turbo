import { describe, expect, test } from "bun:test"

import { ActionError, PropsError } from "./errors"
import { parseExpoTurboDocument, parseTurboStreamFragment } from "./parser"
import { DocumentSession, SessionCommitError } from "./session"
import {
  type BeforeStreamRenderEvent,
  StreamLifecycle,
  type StreamRenderContext,
  streamLifecycleOption,
} from "./stream-lifecycle"
import {
  dispatchEmbeddedTurboStreamElements,
  dispatchGuardedTurboStreamElements,
  dispatchTurboStreamFragment,
} from "./streams"
import { attributeValue, isElement, type ProtocolElement } from "./tree"

function session(xml: string): DocumentSession {
  return new DocumentSession(parseExpoTurboDocument(xml))
}

describe("Stream lifecycle", () => {
  test("awaits the native render scheduler between before-render and each ordered action", async () => {
    const document = session('<Gallery><First id="first"/><Second id="second"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    const order: string[] = []
    lifecycle.subscribe("before-stream-render", (event) => {
      order.push(`before:${event.detail.index}`)
      if (event.detail.index === 0) {
        event.detail.render = async (context) => {
          order.push("renderer:start")
          await Promise.resolve()
          order.push("renderer:default")
          return await context.renderDefault()
        }
      }
      return undefined
    })
    lifecycle.subscribe("stream-action", (event) => {
      order.push(`action:${event.detail.report.index}`)
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="remove" target="first" />
       <turbo-stream action="remove" target="second" />`,
      {
        streamLifecycle: lifecycle,
        streamRenderScheduler: {
          async beforeRender(context) {
            order.push(`schedule:start:${context.index}`)
            await Promise.resolve()
            order.push(`schedule:end:${context.index}`)
          },
        },
      },
    )

    expect(report.actions.map((action) => action.status)).toEqual(["applied", "applied"])
    expect(order).toEqual([
      "before:0",
      "schedule:start:0",
      "schedule:end:0",
      "renderer:start",
      "renderer:default",
      "action:0",
      "before:1",
      "schedule:start:1",
      "schedule:end:1",
      "action:1",
    ])
  })

  test("skips scheduling for canceled actions and isolates a rejected scheduler", async () => {
    const document = session(
      '<Gallery><Canceled id="canceled"/><Rejected id="rejected"/><Later id="later"/></Gallery>',
    )
    const lifecycle = new StreamLifecycle()
    const scheduled: number[] = []
    lifecycle.subscribe("before-stream-render", (event) => {
      if (event.detail.index === 0) event.preventDefault()
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="remove" target="canceled" />
       <turbo-stream action="remove" target="rejected" />
       <turbo-stream action="remove" target="later" />`,
      {
        streamLifecycle: lifecycle,
        streamRenderScheduler: {
          beforeRender(context) {
            scheduled.push(context.index)
            if (context.index === 1) return Promise.reject(new Error("secret scheduler failure"))
            return undefined
          },
        },
      },
    )

    expect(report.actions.map((action) => action.status)).toEqual(["canceled", "error", "applied"])
    expect(report.actions[1]?.error?.message).toBe("Stream render scheduler failed")
    expect(scheduled).toEqual([1, 2])
    expect(document.tree.getElementById("canceled")).toBeDefined()
    expect(document.tree.getElementById("rejected")).toBeDefined()
    expect(document.tree.getElementById("later")).toBeUndefined()
  })

  test("cancels guarded work when ownership is lost while the scheduler is pending", async () => {
    const document = session('<Gallery><First id="first"/></Gallery>')
    const streams = parseTurboStreamFragment(
      '<turbo-stream action="remove" target="first" />',
    ).document.children.filter(
      (node): node is ProtocolElement => isElement(node) && node.kind === "stream",
    )
    let active = true

    const report = await dispatchGuardedTurboStreamElements(
      document,
      streams,
      {
        streamRenderScheduler: {
          async beforeRender() {
            await Promise.resolve()
            active = false
          },
        },
      },
      { shouldContinue: () => active },
    )

    expect(report).toMatchObject({ interrupted: true })
    expect(report.actions.map((action) => action.status)).toEqual(["canceled"])
    expect(document.tree.getElementById("first")).toBeDefined()
  })

  test("orders before-render and action notifications across applied, canceled, no-op, and error siblings", async () => {
    const document = session(
      '<Gallery><Panel id="panel"><Old /></Panel><Keep id="keep"/><Later id="later"/></Gallery>',
    )
    const lifecycle = new StreamLifecycle()
    const order: string[] = []
    lifecycle.subscribe("before-stream-render", (event) => {
      order.push(`before:${event.detail.index}:${event.detail.action}`)
      expect(event.detail.newStream.kind).toBe("stream")
      expect(Object.isFrozen(event.detail)).toBe(true)
      expect(() => Object.assign(event, { type: "changed" })).toThrow()
      if (event.detail.index === 0) {
        const fallback = event.detail.render
        event.detail.render = (context) => {
          order.push("render:before")
          const result = fallback(context)
          order.push("render:after")
          return result
        }
      }
      if (event.detail.index === 1) event.preventDefault()
      return undefined
    })
    lifecycle.subscribe("stream-morph", (event) => {
      order.push(`morph:${event.detail.index}:${event.detail.action}:${event.detail.targetId}`)
      expect(Object.isFrozen(event)).toBe(true)
      expect(Object.isFrozen(event.detail)).toBe(true)
      expect(event.detail).toEqual({ action: "update", index: 0, targetId: "panel" })
      expect(document.tree.getElementById("new")).toBeDefined()
      return undefined
    })
    lifecycle.subscribe("stream-action", (event) => {
      order.push(`action:${event.detail.report.index}:${event.detail.report.status}`)
      expect(Object.isFrozen(event)).toBe(true)
      expect(Object.isFrozen(event.detail)).toBe(true)
      expect(Object.isFrozen(event.detail.report)).toBe(true)
      if (event.detail.report.error) {
        expect(event.detail.report.error.message).toBe("Turbo Stream action failed")
        expect(Object.isFrozen(event.detail.report.error)).toBe(true)
      }
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="update" target="panel" method="morph"><template><New id="new"/></template></turbo-stream>
       <turbo-stream action="append" targets="["><template><Never /></template></turbo-stream>
       <turbo-stream action="remove" target="missing" />
       <turbo-stream action="unknown" target="keep" />
       <turbo-stream action="remove" target="later" />`,
      { streamLifecycle: lifecycle },
    )

    expect(report.actions.map((action) => action.status)).toEqual([
      "applied",
      "canceled",
      "noop",
      "error",
      "applied",
    ])
    expect(order).toEqual([
      "before:0:update",
      "render:before",
      "render:after",
      "morph:0:update:panel",
      "action:0:applied",
      "before:1:append",
      "action:1:canceled",
      "before:2:remove",
      "action:2:noop",
      "before:3:unknown",
      "action:3:error",
      "before:4:remove",
      "action:4:applied",
    ])
    expect(document.tree.getElementById("new")).toBeDefined()
    expect(document.tree.getElementById("keep")).toBeDefined()
    expect(document.tree.getElementById("later")).toBeUndefined()
  })

  test("notifies only successful default standalone Stream morphs", async () => {
    const document = session(
      `<Gallery>
        <Replace id="replace"><Old id="replace-old"/></Replace>
        <Update id="update"><Old id="update-old"/></Update>
        <Plain id="plain"><Old id="plain-old"/></Plain>
        <Canceled id="canceled"><Old id="canceled-old"/></Canceled>
        <Custom id="custom"/>
      </Gallery>`,
    )
    const lifecycle = new StreamLifecycle()
    const order: string[] = []
    lifecycle.subscribe("before-stream-render", (event) => {
      if (event.detail.index === 3) event.preventDefault()
      if (event.detail.index === 4) {
        event.detail.render = (context) => {
          const custom = context.session.tree.getElementById("custom")
          if (!custom) throw new Error("custom target is missing")
          context.session.setAttribute(custom.key, "data-renderer", "replacement")
          return Object.freeze({ appliedTargets: 1, matchedTargets: 1, status: "applied" })
        }
      }
      return undefined
    })
    lifecycle.subscribe("stream-morph", (event) => {
      order.push(`morph:${event.detail.index}:${event.detail.action}:${event.detail.targetId}`)
      expect(Object.isFrozen(event.detail)).toBe(true)
      if (event.detail.targetId === "replace") {
        expect(document.tree.getElementById("replace-fresh")).toBeDefined()
      }
      if (event.detail.targetId === "update") {
        expect(document.tree.getElementById("update-fresh")).toBeDefined()
      }
      return undefined
    })
    lifecycle.subscribe("stream-action", (event) => {
      order.push(`action:${event.detail.report.index}:${event.detail.report.status}`)
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="replace" target="replace" method="morph"><template><Replace id="replace"><Fresh id="replace-fresh"/></Replace></template></turbo-stream>
       <turbo-stream action="update" target="update" method="morph"><template><Fresh id="update-fresh"/></template></turbo-stream>
       <turbo-stream action="update" target="plain" method="replace"><template><Fresh id="plain-fresh"/></template></turbo-stream>
       <turbo-stream action="update" target="canceled" method="morph"><template><Fresh id="canceled-fresh"/></template></turbo-stream>
       <turbo-stream action="update" target="custom" method="morph"><template><Fresh id="custom-fresh"/></template></turbo-stream>
       <turbo-stream action="update" targets="[id]" method="morph"><template><Fresh id="selector-fresh"/></template></turbo-stream>
       <turbo-stream action="update" target="missing" method="morph"><template><Fresh id="missing-fresh"/></template></turbo-stream>`,
      { streamLifecycle: lifecycle },
    )

    expect(report.actions.map((action) => action.status)).toEqual([
      "applied",
      "applied",
      "applied",
      "canceled",
      "applied",
      "error",
      "noop",
    ])
    expect(order).toEqual([
      "morph:0:replace:replace",
      "action:0:applied",
      "morph:1:update:update",
      "action:1:applied",
      "action:2:applied",
      "action:3:canceled",
      "action:4:applied",
      "action:5:error",
      "action:6:noop",
    ])
    expect(document.tree.getElementById("plain-fresh")).toBeDefined()
    expect(document.tree.getElementById("canceled-fresh")).toBeUndefined()
    expect(document.tree.getElementById("custom-fresh")).toBeUndefined()
    expect(
      attributeValue(document.tree.getElementById("custom") as ProtocolElement, "data-renderer"),
    ).toBe("replacement")
  })

  test("keeps Stream morph notifications out of embedded Stream rendering", async () => {
    const document = session('<Gallery><Panel id="panel"><Old/></Panel></Gallery>')
    const lifecycle = new StreamLifecycle()
    const morphs: string[] = []
    const actions: string[] = []
    lifecycle.subscribe("stream-morph", (event) => {
      morphs.push(event.detail.targetId)
      return undefined
    })
    lifecycle.subscribe("stream-action", (event) => {
      actions.push(event.detail.report.status)
      return undefined
    })
    const streams = parseTurboStreamFragment(
      '<turbo-stream action="update" target="panel" method="morph"><template><Fresh id="fresh"/></template></turbo-stream>',
    ).document.children.filter(
      (node): node is ProtocolElement => isElement(node) && node.kind === "stream",
    )

    const report = await dispatchEmbeddedTurboStreamElements(document, streams, {
      streamLifecycle: lifecycle,
    })

    expect(report.actions.map((action) => action.status)).toEqual(["applied"])
    expect(document.tree.getElementById("fresh")).toBeDefined()
    expect(morphs).toEqual([])
    expect(actions).toEqual(["applied"])
  })

  test("keeps cancellation irreversible across later listeners", async () => {
    const document = session('<Gallery><First id="first"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    let eventPrototype: object | undefined
    let defaultPreventedDescriptor: PropertyDescriptor | undefined
    let preventDefaultDescriptor: PropertyDescriptor | undefined
    lifecycle.subscribe("before-stream-render", (event) => {
      event.preventDefault()
      return undefined
    })
    lifecycle.subscribe("before-stream-render", (event) => {
      eventPrototype = Object.getPrototypeOf(event)
      defaultPreventedDescriptor = Object.getOwnPropertyDescriptor(
        eventPrototype,
        "defaultPrevented",
      )
      preventDefaultDescriptor = Object.getOwnPropertyDescriptor(eventPrototype, "preventDefault")
      Object.defineProperties(eventPrototype, {
        defaultPrevented: { configurable: true, get: () => false },
        preventDefault: { configurable: true, value: () => undefined },
      })
      expect(Object.isFrozen(event)).toBe(true)
      expect(Reflect.set(event, "prevented", false)).toBe(false)
      expect(Reflect.set(event, "defaultPrevented", false)).toBe(false)
      expect(event.defaultPrevented).toBe(true)
      return undefined
    })

    const report = await (async () => {
      try {
        return await dispatchTurboStreamFragment(
          document,
          '<turbo-stream action="remove" target="first" />',
          { streamLifecycle: lifecycle },
        )
      } finally {
        if (eventPrototype && defaultPreventedDescriptor && preventDefaultDescriptor) {
          Object.defineProperties(eventPrototype, {
            defaultPrevented: defaultPreventedDescriptor,
            preventDefault: preventDefaultDescriptor,
          })
        }
      }
    })()

    expect(report.actions.map((action) => action.status)).toEqual(["canceled"])
    expect(document.tree.getElementById("first")).toBeDefined()
  })

  test("allows a registered synchronous renderer to replace the default action with an explicit result", async () => {
    const document = session('<Gallery><Panel id="panel"/><Later id="later"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    lifecycle.subscribe("before-stream-render", (event) => {
      if (event.detail.index !== 0) return undefined
      event.detail.render = (context) => {
        expect(Object.isFrozen(context)).toBe(true)
        expect(context.action).toBe("remove")
        expect(context.index).toBe(0)
        expect(context.newStream).toBe(event.detail.newStream)
        expect(context.session).toBe(document)
        const panel = context.session.tree.getElementById("panel")
        expect(panel).toBeDefined()
        if (panel) context.session.setAttribute(panel.key, "data-renderer", "replacement")
        return Object.freeze({ appliedTargets: 1, matchedTargets: 1, status: "applied" })
      }
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="remove" target="panel" />
       <turbo-stream action="remove" target="later" />`,
      { streamLifecycle: lifecycle },
    )

    expect(report.actions.map((action) => action.status)).toEqual(["applied", "applied"])
    const panel = document.tree.getElementById("panel")
    expect(panel).toBeDefined()
    expect(panel && attributeValue(panel, "data-renderer")).toBe("replacement")
    expect(document.tree.getElementById("later")).toBeUndefined()
  })

  test("expires the default render continuation before action observers and dispatch return", async () => {
    const document = session('<Gallery><First id="first"/><Later id="later"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    let savedRender: (() => unknown) | undefined
    lifecycle.subscribe("before-stream-render", (event) => {
      if (event.detail.index === 0) {
        event.detail.render = (context) => {
          savedRender = () => context.renderDefault()
          return Object.freeze({ appliedTargets: 0, matchedTargets: 0, status: "noop" })
        }
      }
      return undefined
    })
    lifecycle.subscribe("stream-action", (event) => {
      if (event.detail.report.index === 0) expect(savedRender).toThrow()
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="remove" target="first" />
       <turbo-stream action="remove" target="later" />`,
      { streamLifecycle: lifecycle },
    )

    expect(report.actions.map((action) => action.status)).toEqual(["noop", "applied"])
    expect(savedRender).toThrow()
    expect(document.tree.getElementById("first")).toBeDefined()
    expect(document.tree.getElementById("later")).toBeUndefined()
  })

  test("keeps the default continuation active until an awaited renderer settles", async () => {
    const document = session('<Gallery><First id="first"/><Later id="later"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    const order: string[] = []
    lifecycle.subscribe("before-stream-render", (event) => {
      if (event.detail.index === 0) {
        event.detail.render = async (context) => {
          order.push("renderer:start")
          await Promise.resolve()
          order.push("renderer:default")
          return await context.renderDefault()
        }
      }
      return undefined
    })
    lifecycle.subscribe("stream-action", (event) => {
      order.push(`action:${event.detail.report.index}`)
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="remove" target="first" />
       <turbo-stream action="remove" target="later" />`,
      { streamLifecycle: lifecycle },
    )

    expect(report.actions.map((action) => action.status)).toEqual(["applied", "applied"])
    expect(order).toEqual(["renderer:start", "renderer:default", "action:0", "action:1"])
    expect(document.tree.getElementById("first")).toBeUndefined()
    expect(document.tree.getElementById("later")).toBeUndefined()
  })

  test("never downgrades committed failures from replacement result getters", async () => {
    for (const property of ["appliedTargets", ["th", "en"].join("")]) {
      const document = session('<Gallery><First id="first"/><Later id="later"/></Gallery>')
      const lifecycle = new StreamLifecycle()
      document.subscribe("id:first", () => {
        throw new Error("committed result getter failure")
      })
      lifecycle.subscribe("before-stream-render", (event) => {
        event.detail.render = (() => {
          const result: Record<string, unknown> = {
            matchedTargets: 0,
            status: "noop",
          }
          Object.defineProperty(result, property, {
            get() {
              document.setAttribute("id:first", "data-result-getter", property)
              return property === "appliedTargets" ? 0 : undefined
            },
          })
          return result
        }) as never
        return undefined
      })

      expect(() =>
        dispatchTurboStreamFragment(
          document,
          `<turbo-stream action="remove" target="first" />
           <turbo-stream action="remove" target="later" />`,
          { streamLifecycle: lifecycle },
        ),
      ).toThrow(SessionCommitError)
      const first = document.tree.getElementById("first")
      expect(first && attributeValue(first, "data-result-getter")).toBe(property)
      expect(document.tree.getElementById("later")).toBeDefined()
    }
  })

  test("awaits replacement renderers and isolates rejected or invalid results", async () => {
    const document = session(
      '<Gallery><First id="first"/><Second id="second"/><Third id="third"/><Later id="later"/></Gallery>',
    )
    const lifecycle = new StreamLifecycle()
    lifecycle.subscribe("before-stream-render", (event) => {
      if (event.detail.index === 0) {
        event.detail.render = async () => {
          await Promise.resolve()
          return Object.freeze({ appliedTargets: 0, matchedTargets: 0, status: "noop" })
        }
      } else if (event.detail.index === 1) {
        event.detail.render = (() => {
          const result = {}
          Object.defineProperty(result, ["th", "en"].join(""), {
            value(resolve: (value?: unknown) => void) {
              resolve(Promise.reject(new Error("nested secret rejection")))
            },
          })
          return result
        }) as never
      } else if (event.detail.index === 2) {
        event.detail.render = (() =>
          Object.freeze({ appliedTargets: 2, matchedTargets: 1, status: "applied" })) as never
      }
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="remove" target="first" />
       <turbo-stream action="remove" target="second" />
       <turbo-stream action="remove" target="third" />
       <turbo-stream action="remove" target="later" />`,
      { streamLifecycle: lifecycle },
    )
    expect(report.actions.map((action) => action.status)).toEqual([
      "noop",
      "error",
      "error",
      "applied",
    ])
    expect(report.actions[0]).toMatchObject({ appliedTargets: 0, matchedTargets: 0 })
    expect(document.tree.getElementById("first")).toBeDefined()
    expect(document.tree.getElementById("second")).toBeDefined()
    expect(document.tree.getElementById("third")).toBeDefined()
    expect(document.tree.getElementById("later")).toBeUndefined()
  })

  test("isolates notification observer faults and keeps stable listener snapshots", async () => {
    const document = session('<Gallery><First id="first"/><Second id="second"/></Gallery>')
    const observerErrors: AggregateError[] = []
    const lifecycle = new StreamLifecycle({
      onObserverError(error) {
        observerErrors.push(error)
        return undefined
      },
    })
    const calls: string[] = []
    let unsubscribeSecond: () => void = () => undefined
    lifecycle.subscribe("stream-action", (event) => {
      calls.push(`first:${event.detail.report.index}`)
      unsubscribeSecond()
      lifecycle.subscribe("stream-action", (next) => {
        calls.push(`late:${next.detail.report.index}`)
        return undefined
      })
      throw new Error("secret observer failure")
    })
    unsubscribeSecond = lifecycle.subscribe("stream-action", (event) => {
      calls.push(`second:${event.detail.report.index}`)
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="remove" target="first" />
       <turbo-stream action="remove" target="second" />`,
      { streamLifecycle: lifecycle },
    )

    expect(report.actions.map((action) => action.status)).toEqual(["applied", "applied"])
    expect(calls).toEqual(["first:0", "second:0", "first:1", "late:1"])
    expect(observerErrors).toHaveLength(2)
    expect(observerErrors[0]?.message).toBe("Stream action notification observers failed")
    expect(observerErrors[0]?.errors[0]?.message).toBe("Stream-action listener failed")
  })

  test("isolates Stream morph observer faults before Stream action notification", async () => {
    const document = session('<Gallery><Panel id="panel"><Old/></Panel></Gallery>')
    const observerErrors: AggregateError[] = []
    const lifecycle = new StreamLifecycle({
      onObserverError(error) {
        observerErrors.push(error)
        return undefined
      },
    })
    const calls: string[] = []
    lifecycle.subscribe("stream-morph", () => {
      calls.push("first")
      throw new Error("secret observer failure")
    })
    lifecycle.subscribe("stream-morph", () => {
      calls.push("second")
      return undefined
    })
    lifecycle.subscribe("stream-action", () => {
      calls.push("action")
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="update" target="panel" method="morph"><template><Fresh id="fresh"/></template></turbo-stream>',
      { streamLifecycle: lifecycle },
    )

    expect(report.actions.map((action) => action.status)).toEqual(["applied"])
    expect(calls).toEqual(["first", "second", "action"])
    expect(observerErrors).toHaveLength(1)
    expect(observerErrors[0]?.message).toBe("Stream morph notification observers failed")
    expect(observerErrors[0]?.errors[0]?.message).toBe("Stream-morph listener failed")
  })

  test("turns a failing before-render listener into one isolated action error", async () => {
    const document = session('<Gallery><First id="first"/><Later id="later"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    lifecycle.subscribe("before-stream-render", (event) => {
      if (event.detail.index === 0) throw new Error("secret listener failure")
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="remove" target="first" />
       <turbo-stream action="remove" target="later" />`,
      { streamLifecycle: lifecycle },
    )

    expect(report.actions.map((action) => action.status)).toEqual(["error", "applied"])
    expect(report.actions[0]?.error?.message).toBe("Before-stream-render listener failed")
    expect(document.tree.getElementById("first")).toBeDefined()
    expect(document.tree.getElementById("later")).toBeUndefined()
  })

  test("redacts replacement renderer errors and revoked proxies", async () => {
    const document = session(
      '<Gallery><First id="first"/><Second id="second"/><Later id="later"/></Gallery>',
    )
    const lifecycle = new StreamLifecycle()
    const observed: string[] = []
    lifecycle.subscribe("before-stream-render", (event) => {
      if (event.detail.index === 0) {
        event.detail.render = () => {
          throw new ActionError("renderer secret", {}, { cause: { token: "secret" } })
        }
      } else if (event.detail.index === 1) {
        event.detail.render = () => {
          const revoked = Proxy.revocable(new ActionError("proxy secret"), {})
          revoked.revoke()
          throw revoked.proxy
        }
      }
      return undefined
    })
    lifecycle.subscribe("stream-action", (event) => {
      observed.push(event.detail.report.error?.message ?? event.detail.report.status)
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="remove" target="first" />
       <turbo-stream action="remove" target="second" />
       <turbo-stream action="remove" target="later" />`,
      { streamLifecycle: lifecycle },
    )

    expect(report.actions.map((action) => action.status)).toEqual(["error", "error", "applied"])
    expect(report.actions[0]?.error).toEqual(
      new ActionError("Stream renderer failed", { action: "remove" }),
    )
    expect(report.actions[1]?.error).toEqual(
      new ActionError("Stream renderer failed", { action: "remove" }),
    )
    expect(observed).toEqual([
      "Turbo Stream action failed",
      "Turbo Stream action failed",
      "applied",
    ])
    expect(document.tree.getElementById("later")).toBeUndefined()
  })

  test("does not trust host-constructed commit errors", async () => {
    const document = session('<Gallery><First id="first"/><Later id="later"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    lifecycle.subscribe("before-stream-render", (event) => {
      if (event.detail.index === 0) {
        throw new SessionCommitError([new Error("host secret")])
      }
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="remove" target="first" />
       <turbo-stream action="remove" target="later" />`,
      { streamLifecycle: lifecycle },
    )

    expect(report.actions.map((action) => action.status)).toEqual(["error", "applied"])
    expect(report.actions[0]?.error?.message).toBe("Before-stream-render listener failed")
    expect(document.revision).toBe(1)
    expect(document.tree.getElementById("first")).toBeDefined()
    expect(document.tree.getElementById("later")).toBeUndefined()
  })

  test("preserves a committed failure from an invalid before-listener then getter", async () => {
    const document = session('<Gallery><First id="first"/><Later id="later"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    document.subscribe("id:first", () => {
      throw new Error("committed before-result failure")
    })
    lifecycle.subscribe("before-stream-render", ((event: BeforeStreamRenderEvent) => {
      if (event.detail.index !== 0) return undefined
      const result = {}
      Object.defineProperty(result, ["th", "en"].join(""), {
        get() {
          document.setAttribute("id:first", "data-before-result", "committed")
          return undefined
        },
      })
      return result
    }) as never)

    expect(() =>
      dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="remove" target="first" />
         <turbo-stream action="remove" target="later" />`,
        { streamLifecycle: lifecycle },
      ),
    ).toThrow(SessionCommitError)
    const first = document.tree.getElementById("first")
    expect(first && attributeValue(first, "data-before-result")).toBe("committed")
    expect(document.tree.getElementById("later")).toBeDefined()
  })

  test("treats an asynchronous renderer's synchronous mutation as committed truth", async () => {
    const document = session('<Gallery><First id="first"/><Later id="later"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    document.subscribe("id:first", () => {
      throw new Error("async renderer finalization failure")
    })
    lifecycle.subscribe("before-stream-render", (event) => {
      event.detail.render = (async (context: StreamRenderContext) => {
        context.session.setAttribute("id:first", "data-async-renderer", "committed")
        return Object.freeze({ appliedTargets: 1, matchedTargets: 1, status: "applied" })
      }) as never
      return undefined
    })

    expect(() =>
      dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="remove" target="first" />
         <turbo-stream action="remove" target="later" />`,
        { streamLifecycle: lifecycle },
      ),
    ).toThrow(SessionCommitError)
    await Promise.resolve()
    const first = document.tree.getElementById("first")
    expect(first && attributeValue(first, "data-async-renderer")).toBe("committed")
    expect(document.tree.getElementById("later")).toBeDefined()
  })

  test("invokes rejected thenables synchronously and preserves their committed mutation", async () => {
    const document = session('<Gallery><First id="first"/><Later id="later"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    let thenCalls = 0
    lifecycle.subscribe("before-stream-render", (event) => {
      event.detail.render = ((context: StreamRenderContext) => {
        const result = {}
        Object.defineProperty(result, ["th", "en"].join(""), {
          value(resolve: (value?: unknown) => void) {
            thenCalls += 1
            context.session.setAttribute("id:first", "data-thenable", "committed")
            resolve()
          },
        })
        return result
      }) as never
      return undefined
    })

    expect(() =>
      dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="remove" target="first" />
         <turbo-stream action="remove" target="later" />`,
        { streamLifecycle: lifecycle },
      ),
    ).toThrow(SessionCommitError)
    expect(thenCalls).toBe(1)
    const first = document.tree.getElementById("first")
    expect(first && attributeValue(first, "data-thenable")).toBe("committed")
    expect(document.tree.getElementById("later")).toBeDefined()
  })

  test("consumes a self-resolving thenable once without starving later actions", async () => {
    const document = session('<Gallery><First id="first"/><Later id="later"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    let thenCalls = 0
    lifecycle.subscribe("before-stream-render", (event) => {
      if (event.detail.index !== 0) return undefined
      const result = {}
      Object.defineProperty(result, ["th", "en"].join(""), {
        value(resolve: (value?: unknown) => void) {
          thenCalls += 1
          resolve(result)
        },
      })
      event.detail.render = (() => result) as never
      return undefined
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="remove" target="first" />
       <turbo-stream action="remove" target="later" />`,
      { streamLifecycle: lifecycle },
    )
    await Promise.resolve()

    expect(report.actions.map((action) => action.status)).toEqual(["error", "applied"])
    expect(thenCalls).toBe(1)
    expect(document.tree.getElementById("first")).toBeDefined()
    expect(document.tree.getElementById("later")).toBeUndefined()
  })

  test("never isolates a committed failure thrown by a before-render listener", async () => {
    const document = session('<Gallery><First id="first"/><Later id="later"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    const actionEvents: number[] = []
    document.subscribe("id:first", () => {
      throw new Error("committed before-listener failure")
    })
    lifecycle.subscribe("before-stream-render", (event) => {
      if (event.detail.index === 0) {
        const first = document.tree.getElementById("first")
        if (first) document.mutate((tree) => tree.removeNode(first))
      }
      return undefined
    })
    lifecycle.subscribe("stream-action", (event) => {
      actionEvents.push(event.detail.report.index)
      return undefined
    })

    expect(() =>
      dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="remove" target="first" />
         <turbo-stream action="remove" target="later" />`,
        { streamLifecycle: lifecycle },
      ),
    ).toThrow(SessionCommitError)
    expect(actionEvents).toEqual([])
    expect(document.tree.getElementById("first")).toBeUndefined()
    expect(document.tree.getElementById("later")).toBeDefined()
  })

  test("marks a guarded action interrupted when before-render loses ownership", async () => {
    const document = session('<Gallery><First id="first"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    let active = true
    lifecycle.subscribe("before-stream-render", () => {
      active = false
      return undefined
    })

    const streams = parseTurboStreamFragment(
      '<turbo-stream action="remove" target="first" />',
    ).document.children.filter(
      (node): node is ProtocolElement => isElement(node) && node.kind === "stream",
    )
    const guarded = await dispatchGuardedTurboStreamElements(
      document,
      streams,
      { streamLifecycle: lifecycle },
      { shouldContinue: () => active },
    )

    expect(guarded).toMatchObject({ interrupted: true })
    expect(guarded.actions.map((action) => action.status)).toEqual(["canceled"])
    expect(document.tree.getElementById("first")).toBeDefined()
  })

  test("does not let a replacement renderer swallow guarded default interruption", async () => {
    const document = session('<Gallery><First id="first"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    let active = true
    lifecycle.subscribe("before-stream-render", (event) => {
      event.detail.render = async (context) => {
        active = false
        try {
          await context.renderDefault()
        } catch {
          return Object.freeze({ appliedTargets: 0, matchedTargets: 0, status: "noop" })
        }
        throw new Error("expected interrupted render")
      }
      return undefined
    })
    const streams = parseTurboStreamFragment(
      '<turbo-stream action="remove" target="first" />',
    ).document.children.filter(
      (node): node is ProtocolElement => isElement(node) && node.kind === "stream",
    )

    const report = await dispatchGuardedTurboStreamElements(
      document,
      streams,
      { streamLifecycle: lifecycle },
      { shouldContinue: () => active },
    )

    expect(report).toMatchObject({ interrupted: true })
    expect(report.actions.map((action) => action.status)).toEqual(["canceled"])
    expect(document.tree.getElementById("first")).toBeDefined()
  })

  test("does not call lifecycle cancellation interrupted when ownership changes afterward", async () => {
    const document = session('<Gallery><First id="first"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    let active = true
    lifecycle.subscribe("before-stream-render", (event) => {
      event.preventDefault()
      return undefined
    })
    lifecycle.subscribe("stream-action", () => {
      active = false
      return undefined
    })
    const streams = parseTurboStreamFragment(
      '<turbo-stream action="remove" target="first" />',
    ).document.children.filter(
      (node): node is ProtocolElement => isElement(node) && node.kind === "stream",
    )

    const report = await dispatchGuardedTurboStreamElements(
      document,
      streams,
      { streamLifecycle: lifecycle },
      { shouldContinue: () => active },
    )

    expect(report).toMatchObject({ interrupted: false })
    expect(report.actions.map((action) => action.status)).toEqual(["canceled"])
    expect(document.tree.getElementById("first")).toBeDefined()
  })

  test("does not infer interruption from a completed no-op after ownership changes", async () => {
    const document = session('<Gallery><First id="first"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    let active = true
    lifecycle.subscribe("stream-action", () => {
      active = false
      return undefined
    })
    const streams = parseTurboStreamFragment(
      '<turbo-stream action="append" target="first"><template /></turbo-stream>',
    ).document.children.filter(
      (node): node is ProtocolElement => isElement(node) && node.kind === "stream",
    )

    const report = await dispatchGuardedTurboStreamElements(
      document,
      streams,
      { streamLifecycle: lifecycle },
      { shouldContinue: () => active },
    )

    expect(report).toMatchObject({ interrupted: false })
    expect(report.actions).toEqual([
      {
        action: "append",
        appliedTargets: 0,
        index: 0,
        matchedTargets: 1,
        status: "noop",
      },
    ])
  })

  test("rethrows a committed default-render failure even when a wrapper catches it", async () => {
    const document = session('<Gallery><First id="first"/><Later id="later"/></Gallery>')
    const lifecycle = new StreamLifecycle()
    const actionEvents: number[] = []
    document.subscribe("id:first", () => {
      throw new Error("committed default-render failure")
    })
    lifecycle.subscribe("before-stream-render", (event) => {
      if (event.detail.index === 0) {
        const fallback = event.detail.render
        event.detail.render = (context) => {
          try {
            fallback(context)
          } catch {
            return Object.freeze({ appliedTargets: 0, matchedTargets: 0, status: "noop" })
          }
          throw new Error("expected committed failure")
        }
      }
      return undefined
    })
    lifecycle.subscribe("stream-action", (event) => {
      actionEvents.push(event.detail.report.index)
      return undefined
    })

    expect(() =>
      dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="remove" target="first" />
         <turbo-stream action="remove" target="later" />`,
        { streamLifecycle: lifecycle },
      ),
    ).toThrow(SessionCommitError)
    expect(actionEvents).toEqual([])
    expect(document.tree.getElementById("first")).toBeUndefined()
    expect(document.tree.getElementById("later")).toBeDefined()
  })

  test("validates lifecycle options and preserves committed finalization failure propagation", async () => {
    const document = session('<Gallery><Panel id="panel"/><Later id="later"/></Gallery>')
    expect(() =>
      dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>', {
        streamLifecycle: {} as never,
      }),
    ).toThrow(PropsError)
    expect(() => new StreamLifecycle({ onObserverError: "invalid" as never })).toThrow(PropsError)
    const revoked = Proxy.revocable({ streamLifecycle: new StreamLifecycle() }, {})
    revoked.revoke()
    expect(() => streamLifecycleOption(revoked.proxy, "Test dispatcher")).toThrow(PropsError)
    expect(() =>
      dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>', {
        streamLifecycle: Object.create(StreamLifecycle.prototype),
      }),
    ).toThrow(PropsError)
    expect(() =>
      dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>', {
        streamLifecycle: new Proxy(new StreamLifecycle(), {}),
      }),
    ).toThrow(PropsError)

    const lifecycle = new StreamLifecycle()
    const actionEvents: number[] = []
    lifecycle.subscribe("stream-action", (event) => {
      actionEvents.push(event.detail.report.index)
      return undefined
    })
    document.subscribe("id:panel", () => {
      throw new Error("committed listener failure")
    })
    expect(() =>
      dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="remove" target="panel" />
         <turbo-stream action="remove" target="later" />`,
        { streamLifecycle: lifecycle },
      ),
    ).toThrow(SessionCommitError)
    expect(actionEvents).toEqual([])
    expect(document.tree.getElementById("panel")).toBeUndefined()
    expect(document.tree.getElementById("later")).toBeDefined()
  })
})
