import { describe, expect, test } from "bun:test"

import type {
  CableReconnectRequest,
  CableStreamSourceConnection,
  CableStreamSourceConnectionSnapshot,
} from "./cable-stream-sources"
import type { DocumentRefreshRequest } from "./document-refresh-controller"
import type { DocumentVisitSnapshot } from "./document-visit-controller"
import { RequestError, StateError } from "./errors"
import {
  type FrameReconnectController,
  FrameReconnectReconciler,
} from "./frame-reconnect-reconciler"
import { parseExpoTurboDocument } from "./parser"
import { RequestLifecycleTransportError } from "./request-lifecycle"
import { DocumentSession } from "./session"
import { dispatchTurboStreamFragment } from "./streams"
import type { ProtocolElement } from "./tree"

class SourceConnections {
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private snapshot: CableStreamSourceConnectionSnapshot = Object.freeze({
    revision: this.revision,
    sources: Object.freeze([]),
  })

  get connectionSnapshot(): CableStreamSourceConnectionSnapshot {
    return this.snapshot
  }

  subscribeConnection(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(sources: readonly CableStreamSourceConnection[]): void {
    this.revision += 1
    this.snapshot = Object.freeze({
      revision: this.revision,
      sources: Object.freeze(sources.map((source) => Object.freeze({ ...source }))),
    })
    for (const listener of [...this.listeners]) listener()
  }
}

class VisitStub {
  private readonly listeners = new Set<() => void>()
  private status: DocumentVisitSnapshot["status"] = "initialized"

  get state(): DocumentVisitSnapshot {
    return Object.freeze({
      busy: this.status === "started",
      previewVisible: false,
      progressVisible: false,
      revision: 0,
      status: this.status,
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setStatus(status: DocumentVisitSnapshot["status"]): void {
    this.status = status
    for (const listener of [...this.listeners]) listener()
  }
}

class FrameStub implements FrameReconnectController {
  private readonly listeners = new Set<() => void>()
  busy = false
  connected = true
  disabled = false
  reloadCalls = 0
  reloadHook: (() => Promise<unknown>) | undefined
  source = "/frame"

  get state(): FrameReconnectController["state"] {
    return Object.freeze({
      busy: this.busy,
      connected: this.connected,
      disabled: this.disabled,
      source: this.source,
    })
  }

  reload(): Promise<unknown> {
    this.reloadCalls += 1
    return this.reloadHook ? this.reloadHook() : Promise.resolve(undefined)
  }

  setBusy(busy: boolean): void {
    this.busy = busy
    for (const listener of [...this.listeners]) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

class FrameLookup {
  readonly controllers = new Map<ProtocolElement, FrameStub>()

  findMounted(frame: ProtocolElement): FrameStub | undefined {
    return this.controllers.get(frame)
  }
}

function session(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      `<Gallery>
        <turbo-cable-stream-source id="document-source" channel="DocumentChannel" />
        <turbo-frame id="outer" src="/outer">
          <turbo-cable-stream-source id="outer-source" channel="OuterChannel" />
          <turbo-frame id="inner" src="/inner">
            <turbo-cable-stream-source id="inner-source" channel="InnerChannel" />
          </turbo-frame>
        </turbo-frame>
        <turbo-frame id="sibling" src="/sibling">
          <turbo-cable-stream-source id="sibling-source" channel="SiblingChannel" />
        </turbo-frame>
      </Gallery>`,
      { url: "https://example.test/current" },
    ),
  )
}

function source(document: DocumentSession, id: string): ProtocolElement {
  const node = document.tree.getElementById(id)
  if (node?.kind !== "stream-source") throw new Error(`Missing Cable source ${id}`)
  return node
}

function frame(document: DocumentSession, id: string): ProtocolElement {
  const node = document.tree.getElementById(id)
  if (node?.kind !== "frame") throw new Error(`Missing Frame ${id}`)
  return node
}

function reconnectRequest(document: DocumentSession, ...ids: string[]): CableReconnectRequest {
  return Object.freeze({
    baseUrl: "https://example.test/current",
    scroll: "preserve" as const,
    sourceKeys: Object.freeze(ids.map((id) => source(document, id).key)),
  })
}

function fixture() {
  const document = session()
  const connections = new SourceConnections()
  const frames = new FrameLookup()
  const visits = new VisitStub()
  const refreshes: DocumentRefreshRequest[] = []
  const errors: Error[] = []
  const reconciler = new FrameReconnectReconciler(
    document,
    connections,
    frames,
    { request: (request) => refreshes.push(request) },
    visits,
    { onError: (error) => errors.push(error) },
  )
  return { connections, document, errors, frames, reconciler, refreshes, visits }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("Frame reconnect reconciler", () => {
  test("gives a document-level source precedence over Frame refreshes", () => {
    const { connections, document, frames, reconciler, refreshes } = fixture()
    const outer = new FrameStub()
    frames.controllers.set(frame(document, "outer"), outer)
    connections.set([
      { nodeKey: source(document, "outer-source").key, state: "connected" },
      { nodeKey: source(document, "document-source").key, state: "connected" },
    ])

    reconciler.request(reconnectRequest(document, "outer-source", "document-source"))

    expect(outer.reloadCalls).toBe(0)
    expect(refreshes).toEqual([{ baseUrl: "https://example.test/current", scroll: "preserve" }])
    expect(Object.isFrozen(refreshes[0])).toBe(true)
    expect("sourceKeys" in (refreshes[0] ?? {})).toBe(false)
  })

  test("reloads active outermost Frames in document order and skips nested sources", async () => {
    const { connections, document, frames, reconciler } = fixture()
    const calls: string[] = []
    const outer = new FrameStub()
    outer.reloadHook = async () => {
      calls.push("outer")
    }
    const inner = new FrameStub()
    inner.reloadHook = async () => {
      calls.push("inner")
    }
    const sibling = new FrameStub()
    sibling.reloadHook = async () => {
      calls.push("sibling")
    }
    frames.controllers.set(frame(document, "outer"), outer)
    frames.controllers.set(frame(document, "inner"), inner)
    frames.controllers.set(frame(document, "sibling"), sibling)
    connections.set([
      { nodeKey: source(document, "sibling-source").key, state: "connected" },
      { nodeKey: source(document, "inner-source").key, state: "connected" },
      { nodeKey: source(document, "outer-source").key, state: "connected" },
    ])

    reconciler.request(reconnectRequest(document, "sibling-source", "inner-source", "outer-source"))
    await settle()

    expect(calls).toEqual(["outer", "sibling"])
    expect(inner.reloadCalls).toBe(0)
  })

  test("keeps a valid nested Frame eligible when its outer Frame is unavailable", async () => {
    const { connections, document, frames, reconciler } = fixture()
    const outer = new FrameStub()
    outer.disabled = true
    const inner = new FrameStub()
    frames.controllers.set(frame(document, "outer"), outer)
    frames.controllers.set(frame(document, "inner"), inner)
    connections.set([
      { nodeKey: source(document, "outer-source").key, state: "connected" },
      { nodeKey: source(document, "inner-source").key, state: "connected" },
    ])

    reconciler.request(reconnectRequest(document, "outer-source", "inner-source"))
    await settle()

    expect(outer.reloadCalls).toBe(0)
    expect(inner.reloadCalls).toBe(1)
  })

  test("waits for the active document visit and a busy owning Frame", async () => {
    const { connections, document, frames, reconciler, visits } = fixture()
    const outer = new FrameStub()
    outer.busy = true
    frames.controllers.set(frame(document, "outer"), outer)
    connections.set([{ nodeKey: source(document, "outer-source").key, state: "connected" }])
    visits.setStatus("started")

    reconciler.request(reconnectRequest(document, "outer-source"))
    expect(outer.reloadCalls).toBe(0)

    visits.setStatus("completed")
    expect(outer.reloadCalls).toBe(0)
    outer.setBusy(false)
    await settle()

    expect(outer.reloadCalls).toBe(1)
  })

  test("waits for captured sources to reconnect and drops terminal or replaced sources", async () => {
    const reconnecting = fixture()
    const outer = new FrameStub()
    reconnecting.frames.controllers.set(frame(reconnecting.document, "outer"), outer)
    const outerKey = source(reconnecting.document, "outer-source").key
    reconnecting.connections.set([{ nodeKey: outerKey, state: "reconnecting" }])

    reconnecting.reconciler.request(reconnectRequest(reconnecting.document, "outer-source"))
    expect(outer.reloadCalls).toBe(0)
    reconnecting.connections.set([{ nodeKey: outerKey, state: "connected" }])
    await settle()
    expect(outer.reloadCalls).toBe(1)

    const replaced = fixture()
    const staleOuter = new FrameStub()
    replaced.frames.controllers.set(frame(replaced.document, "outer"), staleOuter)
    const staleKey = source(replaced.document, "outer-source").key
    replaced.connections.set([{ nodeKey: staleKey, state: "reconnecting" }])
    replaced.reconciler.request(reconnectRequest(replaced.document, "outer-source"))
    replaced.document.replaceTree(
      parseExpoTurboDocument(
        `<Gallery><turbo-frame id="outer" src="/replacement">
          <turbo-cable-stream-source id="outer-source" channel="ReplacementChannel" />
        </turbo-frame></Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    replaced.connections.set([{ nodeKey: staleKey, state: "connected" }])
    await settle()

    expect(staleOuter.reloadCalls).toBe(0)
  })

  test("does not promote unmounted, disabled, or source-less Frames to a document refresh", () => {
    const { connections, document, frames, reconciler, refreshes } = fixture()
    const outer = new FrameStub()
    outer.disabled = true
    frames.controllers.set(frame(document, "outer"), outer)
    connections.set([{ nodeKey: source(document, "outer-source").key, state: "connected" }])

    reconciler.request(reconnectRequest(document, "outer-source"))

    expect(outer.reloadCalls).toBe(0)
    expect(refreshes).toEqual([])
  })

  test("revalidates a later sibling after an earlier Frame reload mutates the tree", async () => {
    const { connections, document, frames, reconciler } = fixture()
    const outer = new FrameStub()
    const sibling = new FrameStub()
    outer.reloadHook = async () => {
      dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="sibling" />')
    }
    frames.controllers.set(frame(document, "outer"), outer)
    frames.controllers.set(frame(document, "sibling"), sibling)
    connections.set([
      { nodeKey: source(document, "outer-source").key, state: "connected" },
      { nodeKey: source(document, "sibling-source").key, state: "connected" },
    ])

    reconciler.request(reconnectRequest(document, "outer-source", "sibling-source"))
    await settle()

    expect(outer.reloadCalls).toBe(1)
    expect(sibling.reloadCalls).toBe(0)
  })

  test("does not reload a later sibling while a document visit starts mid-batch", async () => {
    const { connections, document, frames, reconciler, visits } = fixture()
    const outer = new FrameStub()
    const sibling = new FrameStub()
    let startsVisit = true
    outer.reloadHook = async () => {
      if (!startsVisit) return
      startsVisit = false
      visits.setStatus("started")
    }
    frames.controllers.set(frame(document, "outer"), outer)
    frames.controllers.set(frame(document, "sibling"), sibling)
    connections.set([
      { nodeKey: source(document, "outer-source").key, state: "connected" },
      { nodeKey: source(document, "sibling-source").key, state: "connected" },
    ])

    reconciler.request(reconnectRequest(document, "outer-source", "sibling-source"))
    await settle()
    expect(outer.reloadCalls).toBe(1)
    expect(sibling.reloadCalls).toBe(0)

    visits.setStatus("completed")
    await settle()
    expect(outer.reloadCalls).toBe(2)
    expect(sibling.reloadCalls).toBe(1)
  })

  test("revalidates each sibling and isolates a rejected Frame reload", async () => {
    const { connections, document, errors, frames, reconciler } = fixture()
    const outer = new FrameStub()
    const sibling = new FrameStub()
    outer.reloadHook = async () => {
      throw new Error("secret Frame request failure")
    }
    frames.controllers.set(frame(document, "outer"), outer)
    frames.controllers.set(frame(document, "sibling"), sibling)
    connections.set([
      { nodeKey: source(document, "outer-source").key, state: "connected" },
      { nodeKey: source(document, "sibling-source").key, state: "connected" },
    ])

    reconciler.request(reconnectRequest(document, "outer-source", "sibling-source"))
    await settle()

    expect(outer.reloadCalls).toBe(1)
    expect(sibling.reloadCalls).toBe(1)
    expect(errors).toEqual([new RequestError("Frame reconnect reconciliation failed")])
    expect(errors[0]?.cause).toBeUndefined()
  })

  test("honors prevented request-lifecycle failure handling", async () => {
    const { connections, document, errors, frames, reconciler } = fixture()
    const outer = new FrameStub()
    outer.reloadHook = async () => {
      throw new RequestLifecycleTransportError("secret Frame transport failure", true, {
        frameId: "outer",
      })
    }
    frames.controllers.set(frame(document, "outer"), outer)
    connections.set([{ nodeKey: source(document, "outer-source").key, state: "connected" }])

    reconciler.request(reconnectRequest(document, "outer-source"))
    await settle()

    expect(outer.reloadCalls).toBe(1)
    expect(errors).toEqual([])
  })

  test("fails closed for invalid handoffs and stops deferred work on disposal", () => {
    const { connections, document, frames, reconciler } = fixture()
    const outer = new FrameStub()
    frames.controllers.set(frame(document, "outer"), outer)
    const key = source(document, "outer-source").key
    connections.set([{ nodeKey: key, state: "reconnecting" }])

    expect(() =>
      reconciler.request({
        baseUrl: "https://user:secret-token@example.test/current",
        scroll: "preserve",
        sourceKeys: [key],
      }),
    ).toThrow(RequestError)
    reconciler.request(reconnectRequest(document, "outer-source"))
    reconciler.dispose()
    connections.set([{ nodeKey: key, state: "connected" }])

    expect(outer.reloadCalls).toBe(0)
    expect(() => reconciler.request(reconnectRequest(document, "outer-source"))).toThrow(StateError)
  })
})
