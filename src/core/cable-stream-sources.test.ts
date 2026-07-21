import { describe, expect, test } from "bun:test"

import {
  type CableAdapter,
  type CableCallbacks,
  type CableSubscription,
  type ClockAdapter,
  decodeActionCableV1Frame,
  type TurboRequest,
  type TurboResponse,
} from "../adapters"
import {
  type CableStreamSourceConnectionSnapshot,
  CableStreamSourceRegistry,
} from "./cable-stream-sources"
import { DocumentRequestLoader } from "./document-loader"
import {
  DocumentReconnectReconciler,
  DocumentRefreshController,
} from "./document-refresh-controller"
import { DocumentVisitController } from "./document-visit-controller"
import { StateError, SubscriptionError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import { EXPO_TURBO_MIME_TYPE } from "./protocol-request"
import { DocumentSession } from "./session"
import { StreamLifecycle } from "./stream-lifecycle"
import { attributeValue, isElement, type ProtocolElement } from "./tree"

interface FakeSubscriptionRecord {
  readonly callbacks: CableCallbacks
  readonly identifier: string
  unsubscribeCalls: number
}

class FakeCable implements CableAdapter {
  readonly records: FakeSubscriptionRecord[] = []
  subscribeError: Error | undefined
  subscribeHook: ((callbacks: CableCallbacks) => void) | undefined
  unsubscribeResult: unknown
  unsubscribeThrows = false

  subscribe(identifier: string, callbacks: CableCallbacks): CableSubscription {
    if (this.subscribeError) throw this.subscribeError
    const record: FakeSubscriptionRecord = {
      callbacks,
      identifier,
      unsubscribeCalls: 0,
    }
    this.records.push(record)
    this.subscribeHook?.(callbacks)
    return {
      unsubscribe: () => {
        record.unsubscribeCalls += 1
        if (this.unsubscribeThrows) throw new Error("secret unsubscribe details")
        return this.unsubscribeResult
      },
    } as CableSubscription
  }
}

interface TimerRecord {
  readonly callback: () => void
  cleared: boolean
  readonly handle: object
}

class ManualClock implements ClockAdapter {
  readonly timers: TimerRecord[] = []

  clearTimeout(handle: unknown): void {
    const timer = this.timers.find((candidate) => candidate.handle === handle)
    if (timer) timer.cleared = true
  }

  now(): number {
    return 0
  }

  setTimeout(callback: () => void, _delayMs: number): unknown {
    const handle = Object.freeze({})
    this.timers.push({ callback, cleared: false, handle })
    return handle
  }

  fire(index: number): void {
    const timer = this.timers[index]
    if (!timer) throw new Error(`Missing timer ${index}`)
    if (!timer.cleared) timer.callback()
  }
}

function session(xml: string): DocumentSession {
  return new DocumentSession(parseExpoTurboDocument(xml))
}

function source(document: DocumentSession, id: string): ProtocolElement {
  const node = document.tree.getElementById(id)
  if (node?.kind !== "stream-source") throw new Error(`Missing source ${id}`)
  return node
}

function text(document: DocumentSession, id: string): string {
  const node = document.tree.getElementById(id)
  if (!node) return ""
  return node.children.flatMap((child) => (child.kind === "text" ? [child.value] : [])).join("")
}

async function flushRelease(): Promise<void> {
  await Promise.resolve()
}

describe("Cable stream source registry", () => {
  test("publishes redacted per-source connection state for shared subscriptions", async () => {
    const document = session(`<Gallery>
      <turbo-cable-stream-source
        id="first"
        channel="Turbo::StreamsChannel"
        signed-stream-name="signed-secret"
      />
      <turbo-cable-stream-source
        id="second"
        channel="Turbo::StreamsChannel"
        signed-stream-name="signed-secret"
      />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })
    const snapshots: CableStreamSourceConnectionSnapshot[] = []
    const unsubscribe = registry.subscribeConnection(() => {
      snapshots.push(registry.connectionSnapshot)
    })

    const initial = registry.connectionSnapshot
    expect(initial).toEqual({ revision: 0, sources: [] })
    expect(Object.isFrozen(initial)).toBe(true)
    expect(Object.isFrozen(initial.sources)).toBe(true)

    const releaseFirst = registry.retain(source(document, "first"))
    const connectingFirst = registry.connectionSnapshot
    expect(connectingFirst).toEqual({
      revision: 1,
      sources: [{ nodeKey: "id:first", state: "connecting" }],
    })
    expect(JSON.stringify(connectingFirst)).not.toContain("signed-secret")

    const releaseSecond = registry.retain(source(document, "second"))
    const connectingShared = registry.connectionSnapshot
    expect(connectingShared).toEqual({
      revision: 2,
      sources: [
        { nodeKey: "id:first", state: "connecting" },
        { nodeKey: "id:second", state: "connecting" },
      ],
    })
    expect(cable.records).toHaveLength(1)

    cable.records[0]?.callbacks.connected(false)
    const connected = registry.connectionSnapshot
    expect(connected).toEqual({
      revision: 3,
      sources: [
        { nodeKey: "id:first", state: "connected" },
        { nodeKey: "id:second", state: "connected" },
      ],
    })
    cable.records[0]?.callbacks.connected(true)
    expect(registry.connectionSnapshot).toBe(connected)

    cable.records[0]?.callbacks.disconnected(true)
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:first", state: "reconnecting" },
      { nodeKey: "id:second", state: "reconnecting" },
    ])
    cable.records[0]?.callbacks.disconnected()
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:first", state: "disconnected" },
      { nodeKey: "id:second", state: "disconnected" },
    ])
    cable.records[0]?.callbacks.rejected()
    const rejected = registry.connectionSnapshot
    expect(rejected.sources).toEqual([
      { nodeKey: "id:first", state: "rejected" },
      { nodeKey: "id:second", state: "rejected" },
    ])
    expect(Object.isFrozen(rejected.sources[0])).toBe(true)

    releaseFirst()
    await flushRelease()
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:second", state: "rejected" },
    ])
    releaseSecond()
    await flushRelease()
    const released = registry.connectionSnapshot
    expect(released.sources).toEqual([])
    cable.records[0]?.callbacks.connected(false)
    expect(registry.connectionSnapshot).toBe(released)
    expect(snapshots).toHaveLength(8)
    expect(snapshots[0]).toBe(connectingFirst)
    expect(snapshots[1]).toBe(connectingShared)
    expect(snapshots[2]).toBe(connected)
    expect(snapshots[5]).toBe(rejected)
    expect(snapshots[7]).toBe(released)
    unsubscribe()
    expect(errors).toEqual([])
  })

  test("reconciles once after active server-directed reconfirmation", async () => {
    const url = "https://example.test/current"
    const document = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery>
        <turbo-cable-stream-source id="first" channel="FirstChannel" />
        <turbo-cable-stream-source id="second" channel="SecondChannel" />
      </Gallery>`,
        { url },
      ),
    )
    const cable = new FakeCable()
    const clock = new ManualClock()
    const refreshes: Array<readonly [string, string | undefined]> = []
    const refresh = new DocumentRefreshController(
      document,
      {
        refreshCurrent: async (baseUrl, _method, scroll) => {
          refreshes.push([baseUrl, scroll])
          return undefined
        },
      },
      clock,
    )
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: () => undefined,
      reconnectRefresh: refresh,
    })
    const releaseFirst = registry.retain(source(document, "first"))
    const releaseSecond = registry.retain(source(document, "second"))
    const first = cable.records[0]
    const second = cable.records[1]
    if (!first || !second) throw new Error("Missing Cable subscriptions")

    first.callbacks.connected(false)
    second.callbacks.connected(false)
    first.callbacks.connected(true)
    expect(clock.timers).toHaveLength(0)

    first.callbacks.disconnected(true)
    second.callbacks.disconnected(true)
    first.callbacks.connected(true)
    first.callbacks.connected(true)
    second.callbacks.connected(true)

    expect(clock.timers).toHaveLength(1)
    clock.fire(0)
    expect(refreshes).toEqual([[url, "preserve"]])

    second.callbacks.disconnected(false)
    second.callbacks.connected(true)
    expect(clock.timers).toHaveLength(1)

    first.callbacks.disconnected(true)
    releaseFirst()
    await flushRelease()
    first.callbacks.connected(true)
    expect(clock.timers).toHaveLength(1)

    releaseSecond()
    await flushRelease()
    refresh.dispose()
  })

  test("hands the reconnect reconciler frozen active source keys without Cable credentials", () => {
    const document = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery>
          <turbo-cable-stream-source
            id="first"
            channel="Turbo::StreamsChannel"
            signed-stream-name="signed-secret-first"
          />
          <turbo-cable-stream-source
            id="second"
            channel="Turbo::StreamsChannel"
            signed-stream-name="signed-secret-second"
          />
        </Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    const cable = new FakeCable()
    const requests: unknown[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: () => undefined,
      reconnectRefresh: { request: (request) => requests.push(request) },
    })
    registry.retain(source(document, "first"))
    registry.retain(source(document, "second"))
    const first = cable.records[0]
    const second = cable.records[1]
    if (!first || !second) throw new Error("Missing Cable subscriptions")

    first.callbacks.connected(false)
    second.callbacks.connected(false)
    first.callbacks.disconnected(true)
    second.callbacks.disconnected(true)
    first.callbacks.connected(true)

    expect(requests).toEqual([
      {
        baseUrl: "https://example.test/current",
        scroll: "preserve",
        sourceKeys: ["id:first", "id:second"],
      },
    ])
    expect(Object.isFrozen(requests[0])).toBe(true)
    const request = requests[0] as { sourceKeys?: unknown }
    expect(Object.isFrozen(request.sourceKeys)).toBe(true)
    expect(JSON.stringify(requests)).not.toContain("signed-secret")
  })

  test("redacts a reconnect reconciliation failure", () => {
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-cable-stream-source id="source" channel="DemoChannel" /></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
      reconnectRefresh: {
        request: () => {
          throw new Error("secret reconciliation details")
        },
      },
    })
    registry.retain(source(document, "source"))
    const record = cable.records[0]
    if (!record) throw new Error("Missing Cable subscription")

    record.callbacks.connected(false)
    record.callbacks.disconnected(true)
    record.callbacks.connected(true)

    expect(errors).toEqual([
      new SubscriptionError("Cable stream source reconnect reconciliation failed", {
        target: "id:source",
      }),
    ])
    expect(errors[0]?.cause).toBeUndefined()
  })

  test("drops a scheduled reconnect refresh when a newer visit owns the document", async () => {
    const currentUrl = "https://example.test/current"
    const nextUrl = "https://example.test/next"
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-cable-stream-source id="source" channel="DemoChannel" /></Gallery>',
        { url: currentUrl },
      ),
    )
    const clock = new ManualClock()
    const requests: TurboRequest[] = []
    let resolveVisit: ((response: TurboResponse) => void) | undefined
    const loader = new DocumentRequestLoader(
      document,
      {
        fetch: (request) => {
          requests.push(request)
          return new Promise<TurboResponse>((resolve) => {
            resolveVisit = resolve
          })
        },
      },
      { next: () => "request-1" },
    )
    const visits = new DocumentVisitController(loader, clock)
    const refresh = new DocumentRefreshController(document, visits, clock)
    const cable = new FakeCable()
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: () => undefined,
      reconnectRefresh: refresh,
    })
    registry.retain(source(document, "source"))
    const record = cable.records[0]
    if (!record) throw new Error("Missing Cable subscription")

    record.callbacks.connected(false)
    record.callbacks.disconnected(true)
    record.callbacks.connected(true)
    expect(clock.timers).toHaveLength(1)

    const visit = visits.visit(nextUrl)
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: "GET", url: nextUrl })
    clock.fire(0)
    expect(requests).toHaveLength(1)

    const resolve = resolveVisit
    if (!resolve) throw new Error("Missing active document visit")
    resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => "<Gallery/>",
      url: nextUrl,
    })
    await visit
    registry.dispose()
    refresh.dispose()
  })

  test("defers reconnect reconciliation until the active current-document visit settles", async () => {
    const currentUrl = "https://example.test/current"
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-cable-stream-source id="source" channel="DemoChannel" /></Gallery>',
        { url: currentUrl },
      ),
    )
    const clock = new ManualClock()
    const requests: TurboRequest[] = []
    let resolveVisit: ((response: TurboResponse) => void) | undefined
    const loader = new DocumentRequestLoader(
      document,
      {
        fetch: (request) => {
          requests.push(request)
          return new Promise<TurboResponse>((resolve) => {
            resolveVisit = resolve
          })
        },
      },
      { next: () => "request-1" },
    )
    const visits = new DocumentVisitController(loader, clock)
    const refresh = new DocumentRefreshController(document, visits, clock)
    const reconnectRefresh = new DocumentReconnectReconciler(refresh, visits)
    const cable = new FakeCable()
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: () => undefined,
      reconnectRefresh,
    })
    registry.retain(source(document, "source"))
    const record = cable.records[0]
    if (!record) throw new Error("Missing Cable subscription")

    const visit = visits.visit(currentUrl)
    await Promise.resolve()
    expect(requests).toHaveLength(1)

    record.callbacks.connected(false)
    record.callbacks.disconnected(true)
    record.callbacks.connected(true)
    expect(clock.timers).toHaveLength(1)

    const resolve = resolveVisit
    if (!resolve) throw new Error("Missing active document visit")
    resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => "<Gallery/>",
      url: currentUrl,
    })
    await visit

    expect(clock.timers).toHaveLength(2)
    clock.fire(1)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ method: "GET", url: currentUrl })

    registry.dispose()
    reconnectRefresh.dispose()
    refresh.dispose()
  })

  test("drops deferred reconnect reconciliation when the settled visit changes documents", async () => {
    const currentUrl = "https://example.test/current"
    const nextUrl = "https://example.test/next"
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-cable-stream-source id="source" channel="DemoChannel" /></Gallery>',
        { url: currentUrl },
      ),
    )
    const clock = new ManualClock()
    const requests: TurboRequest[] = []
    let resolveVisit: ((response: TurboResponse) => void) | undefined
    const loader = new DocumentRequestLoader(
      document,
      {
        fetch: (request) => {
          requests.push(request)
          return new Promise<TurboResponse>((resolve) => {
            resolveVisit = resolve
          })
        },
      },
      { next: () => "request-1" },
    )
    const visits = new DocumentVisitController(loader, clock)
    const refresh = new DocumentRefreshController(document, visits, clock)
    const reconnectRefresh = new DocumentReconnectReconciler(refresh, visits)
    const cable = new FakeCable()
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: () => undefined,
      reconnectRefresh,
    })
    registry.retain(source(document, "source"))
    const record = cable.records[0]
    if (!record) throw new Error("Missing Cable subscription")

    const visit = visits.visit(nextUrl)
    await Promise.resolve()
    expect(requests).toHaveLength(1)

    record.callbacks.connected(false)
    record.callbacks.disconnected(true)
    record.callbacks.connected(true)

    const resolve = resolveVisit
    if (!resolve) throw new Error("Missing active document visit")
    resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => "<Gallery/>",
      url: nextUrl,
    })
    await visit

    expect(clock.timers).toHaveLength(2)
    clock.fire(1)
    expect(requests).toHaveLength(1)

    registry.dispose()
    reconnectRefresh.dispose()
    refresh.dispose()
  })

  test("does not reconcile a reconfirmation superseded by a connection observer", () => {
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-cable-stream-source id="source" channel="DemoChannel" /></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const cable = new FakeCable()
    const requests: unknown[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: () => undefined,
      reconnectRefresh: { request: (request) => requests.push(request) },
    })
    let supersedeConfirmation = false
    registry.subscribeConnection(() => {
      if (!supersedeConfirmation) return
      if (registry.connectionSnapshot.sources[0]?.state !== "connected") return
      supersedeConfirmation = false
      cable.records[0]?.callbacks.disconnected(true)
    })
    registry.retain(source(document, "source"))
    const record = cable.records[0]
    if (!record) throw new Error("Missing Cable subscription")

    record.callbacks.connected(false)
    supersedeConfirmation = true
    record.callbacks.disconnected(true)
    record.callbacks.connected(true)

    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:source", state: "reconnecting" },
    ])
    expect(requests).toEqual([])
  })

  test("rebinds connection state and ignores stale transport callbacks", async () => {
    const document = session(`<Gallery>
      <turbo-cable-stream-source id="source" channel="FirstChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })

    const release = registry.retain(source(document, "source"))
    const first = cable.records[0]
    if (!first) throw new Error("Missing first subscription")
    first.callbacks.connected(false)
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:source", state: "connected" },
    ])

    document.setAttribute("id:source", "channel", "SecondChannel")
    const second = cable.records[1]
    if (!second) throw new Error("Missing second subscription")
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:source", state: "connecting" },
    ])
    first.callbacks.rejected()
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:source", state: "connecting" },
    ])

    second.callbacks.rejected()
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:source", state: "rejected" },
    ])
    document.removeAttribute("id:source", "channel")
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:source", state: "disconnected" },
    ])
    second.callbacks.connected(false)
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:source", state: "disconnected" },
    ])

    release()
    await flushRelease()
    expect(registry.connectionSnapshot.sources).toEqual([])
    expect(errors).toEqual([
      new SubscriptionError("Cable stream source channel must be a nonblank token", {
        target: "id:source",
      }),
    ])
  })

  test("isolates connection observers without exposing their failures", async () => {
    const document = session(`<Gallery>
      <turbo-cable-stream-source id="source" channel="DemoChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })
    let selfCalls = 0
    let otherCalls = 0
    let unsubscribeSelf: () => void = () => undefined
    unsubscribeSelf = registry.subscribeConnection(() => {
      selfCalls += 1
      unsubscribeSelf()
      throw new Error("private connection observer failure")
    })
    registry.subscribeConnection(() => {
      otherCalls += 1
    })

    const release = registry.retain(source(document, "source"))
    cable.records[0]?.callbacks.connected(false)
    expect(selfCalls).toBe(1)
    expect(otherCalls).toBe(2)
    expect(errors).toEqual([
      new SubscriptionError("Cable stream source connection observer failed"),
    ])
    expect(errors[0]?.message).not.toContain("private")

    release()
    await flushRelease()
    expect(otherCalls).toBe(3)
  })

  test("keeps only the current transport after connection-observer rebind reentrancy", async () => {
    const document = session(`<Gallery>
      <turbo-cable-stream-source id="source" channel="FirstChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })
    let rebound = false
    registry.subscribeConnection(() => {
      if (rebound || registry.connectionSnapshot.sources[0]?.state !== "connecting") return
      rebound = true
      document.setAttribute("id:source", "channel", "FinalChannel")
    })

    const release = registry.retain(source(document, "source"))

    expect(cable.records.map((record) => record.identifier)).toEqual([
      JSON.stringify({ channel: "FirstChannel", signed_stream_name: null }),
      JSON.stringify({ channel: "FinalChannel", signed_stream_name: null }),
    ])
    expect(cable.records[0]?.unsubscribeCalls).toBe(1)
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:source", state: "connecting" },
    ])
    cable.records[0]?.callbacks.connected(false)
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:source", state: "connecting" },
    ])
    cable.records[1]?.callbacks.connected(false)
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:source", state: "connected" },
    ])

    release()
    await flushRelease()
    expect(cable.records[1]?.unsubscribeCalls).toBe(1)
    expect(errors).toEqual([])
  })

  test("does not duplicate a later observer after a reentrant connection-state rebind", async () => {
    const document = session(`<Gallery>
      <turbo-cable-stream-source id="source" channel="FirstChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })
    const firstRevisions: number[] = []
    const secondRevisions: number[] = []
    let rebound = false
    registry.subscribeConnection(() => {
      const snapshot = registry.connectionSnapshot
      firstRevisions.push(snapshot.revision)
      if (rebound || snapshot.sources[0]?.state !== "connected") return
      rebound = true
      document.setAttribute("id:source", "channel", "FinalChannel")
    })
    registry.subscribeConnection(() => {
      secondRevisions.push(registry.connectionSnapshot.revision)
    })

    const release = registry.retain(source(document, "source"))
    cable.records[0]?.callbacks.connected(false)

    expect(firstRevisions).toEqual([1, 2, 3])
    expect(secondRevisions).toEqual([1, 3])
    expect(cable.records[0]?.unsubscribeCalls).toBe(1)
    expect(cable.records).toHaveLength(2)
    expect(registry.connectionSnapshot.sources).toEqual([
      { nodeKey: "id:source", state: "connecting" },
    ])

    release()
    await flushRelease()
    expect(cable.records[1]?.unsubscribeCalls).toBe(1)
    expect(errors).toEqual([])
  })

  test("canonicalizes the full identifier and refcounts duplicate active sources", async () => {
    const document = session(`<Gallery>
      <turbo-cable-stream-source
        id="first"
        channel="DemoChannel"
        signed-stream-name="signed-secret"
        data-aa="letter"
        data-a-z="underscore"
        data-zone="west"
        data-room-name="Room 1"
      />
      <turbo-cable-stream-source
        id="second"
        data-room-name="Room 1"
        data-a-z="underscore"
        signed-stream-name="signed-secret"
        data-aa="letter"
        channel="DemoChannel"
        data-zone="west"
      />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })

    const releaseFirst = registry.retain(source(document, "first"))
    const releaseSecond = registry.retain(source(document, "second"))

    expect(cable.records).toHaveLength(1)
    expect(cable.records[0]?.identifier).toBe(
      JSON.stringify({
        channel: "DemoChannel",
        signed_stream_name: "signed-secret",
        a_z: "underscore",
        aa: "letter",
        room_name: "Room 1",
        zone: "west",
      }),
    )

    releaseFirst()
    await flushRelease()
    expect(cable.records[0]?.unsubscribeCalls).toBe(0)
    releaseSecond()
    await flushRelease()
    expect(cable.records[0]?.unsubscribeCalls).toBe(1)
    expect(errors).toEqual([])
  })

  test("admits canonical standard/custom channels and rejects unsafe identifiers", () => {
    const document = session(`<Gallery>
      <turbo-cable-stream-source id="custom" channel="CustomChannel" />
      <turbo-cable-stream-source id="missing-channel" />
      <turbo-cable-stream-source id="empty-channel" channel="" />
      <turbo-cable-stream-source
        id="valid-standard"
        channel="Turbo::StreamsChannel"
        signed-stream-name="signed-secret"
      />
      <turbo-cable-stream-source id="standard" channel="Turbo::StreamsChannel" />
      <turbo-cable-stream-source
        id="blank-standard"
        channel="Turbo::StreamsChannel"
        signed-stream-name=""
      />
      <turbo-cable-stream-source
        id="reserved"
        channel="CustomChannel"
        data-signed-stream-name="override"
      />
      <turbo-cable-stream-source
        id="collision"
        channel="CustomChannel"
        data-room-name="one"
        data-room_name="two"
      />
      <turbo-cable-stream-source
        id="malformed"
        channel="CustomChannel"
        data-room--name="one"
      />
      <turbo-cable-stream-source id="padded" channel=" CustomChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })

    registry.retain(source(document, "custom"))
    expect(cable.records[0]?.identifier).toBe(
      JSON.stringify({ channel: "CustomChannel", signed_stream_name: null }),
    )
    registry.retain(source(document, "valid-standard"))
    expect(cable.records[1]?.identifier).toBe(
      JSON.stringify({
        channel: "Turbo::StreamsChannel",
        signed_stream_name: "signed-secret",
      }),
    )
    for (const id of ["missing-channel", "empty-channel"]) {
      expect(() => registry.retain(source(document, id))).toThrow(
        new SubscriptionError("Cable stream source channel must be a nonblank token", {
          target: `id:${id}`,
        }),
      )
    }
    expect(() => registry.retain(source(document, "standard"))).toThrow(
      new SubscriptionError("Turbo Streams Cable sources require a signed stream name", {
        target: "id:standard",
      }),
    )
    expect(() => registry.retain(source(document, "blank-standard"))).toThrow(
      new SubscriptionError("Cable stream source signed stream name must be a nonblank token", {
        target: "id:blank-standard",
      }),
    )
    expect(() => registry.retain(source(document, "reserved"))).toThrow(
      new SubscriptionError("Cable stream source data parameter is reserved", {
        target: "id:reserved",
      }),
    )
    expect(() => registry.retain(source(document, "collision"))).toThrow(
      new SubscriptionError("Cable stream source data parameters collide", {
        target: "id:collision",
      }),
    )
    expect(() => registry.retain(source(document, "malformed"))).toThrow(
      new SubscriptionError("Cable stream source data parameter is invalid", {
        target: "id:malformed",
      }),
    )
    expect(() => registry.retain(source(document, "padded"))).toThrow(
      new SubscriptionError("Cable stream source channel must be a nonblank token", {
        target: "id:padded",
      }),
    )
    expect(errors).toHaveLength(8)
    expect(errors.every((error) => error instanceof SubscriptionError)).toBe(true)
    expect(errors.every((error) => error.cause === undefined)).toBe(true)
  })

  test("rebinds descriptor changes synchronously and recovers from invalid attributes", () => {
    const document = session(`<Gallery>
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="source" channel="OldChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })
    registry.retain(source(document, "source"))
    const old = cable.records[0]
    if (!old) throw new Error("Missing old subscription")

    document.setAttribute("id:source", "channel", "NewChannel")

    const current = cable.records[1]
    if (!current) throw new Error("Missing rebound subscription")
    expect(old.unsubscribeCalls).toBe(1)
    old.callbacks.received(
      '<turbo-stream action="update" target="status"><template>stale</template></turbo-stream>',
    )
    expect(text(document, "status")).toBe("old")
    current.callbacks.received(
      '<turbo-stream action="update" target="status"><template>fresh</template></turbo-stream>',
    )
    expect(text(document, "status")).toBe("fresh")

    document.removeAttribute("id:source", "channel")
    expect(current.unsubscribeCalls).toBe(1)
    expect(errors).toEqual([
      new SubscriptionError("Cable stream source channel must be a nonblank token", {
        target: "id:source",
      }),
    ])
    current.callbacks.received(
      '<turbo-stream action="update" target="status"><template>invalid</template></turbo-stream>',
    )
    expect(text(document, "status")).toBe("fresh")

    document.setAttribute("id:source", "channel", "RestoredChannel")
    expect(cable.records[2]?.identifier).toBe(
      JSON.stringify({ channel: "RestoredChannel", signed_stream_name: null }),
    )
  })

  test("does not resume a stale rebind after unsubscribe-error observer reentrancy", () => {
    const document = session(`<Gallery>
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="source" channel="FirstChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    let corrected = false
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => {
        errors.push(error)
        if (corrected) return
        corrected = true
        document.setAttribute("id:source", "channel", "FinalChannel")
      },
    })
    registry.retain(source(document, "source"))
    const first = cable.records[0]
    if (!first) throw new Error("Missing first subscription")
    cable.unsubscribeThrows = true

    document.setAttribute("id:source", "channel", "StaleChannel")

    expect(cable.records.map((record) => record.identifier)).toEqual([
      JSON.stringify({ channel: "FirstChannel", signed_stream_name: null }),
      JSON.stringify({ channel: "FinalChannel", signed_stream_name: null }),
    ])
    expect(errors).toEqual([
      new SubscriptionError("Cable stream source unsubscribe failed", {
        target: "id:source",
      }),
    ])
    first.callbacks.received(
      '<turbo-stream action="update" target="status"><template>stale</template></turbo-stream>',
    )
    expect(text(document, "status")).toBe("old")
    cable.records[1]?.callbacks.received(
      '<turbo-stream action="update" target="status"><template>fresh</template></turbo-stream>',
    )
    expect(text(document, "status")).toBe("fresh")
  })

  test("does not report a superseded subscribe failure after a reentrant rebind", () => {
    const document = session(`<Gallery>
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="source" channel="FirstChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })
    registry.retain(source(document, "source"))
    const first = cable.records[0]
    if (!first) throw new Error("Missing first subscription")
    cable.subscribeHook = () => {
      cable.subscribeHook = undefined
      document.setAttribute("id:source", "channel", "FinalChannel")
      throw new Error("secret stale subscription details")
    }

    document.setAttribute("id:source", "channel", "StaleChannel")

    expect(cable.records.map((record) => record.identifier)).toEqual([
      JSON.stringify({ channel: "FirstChannel", signed_stream_name: null }),
      JSON.stringify({ channel: "StaleChannel", signed_stream_name: null }),
      JSON.stringify({ channel: "FinalChannel", signed_stream_name: null }),
    ])
    expect(first.unsubscribeCalls).toBe(1)
    expect(errors).toEqual([])
    cable.records[1]?.callbacks.received(
      '<turbo-stream action="update" target="status"><template>stale</template></turbo-stream>',
    )
    expect(text(document, "status")).toBe("old")
    cable.records[2]?.callbacks.received(
      '<turbo-stream action="update" target="status"><template>fresh</template></turbo-stream>',
    )
    expect(text(document, "status")).toBe("fresh")
  })

  test("reports a current subscribe failure after a same-identifier notification", () => {
    const document = session(`<Gallery>
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="source" channel="CurrentChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    cable.subscribeHook = () => {
      cable.subscribeHook = undefined
      document.setAttribute("id:source", "channel", "CurrentChannel")
      throw new Error("secret current subscription details")
    }
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })

    expect(() => registry.retain(source(document, "source"))).toThrow(
      new SubscriptionError("Cable stream source subscription failed", {
        target: "id:source",
      }),
    )
    expect(errors).toEqual([
      new SubscriptionError("Cable stream source subscription failed", {
        target: "id:source",
      }),
    ])
    cable.records[0]?.callbacks.received(
      '<turbo-stream action="update" target="status"><template>stale</template></turbo-stream>',
    )
    expect(text(document, "status")).toBe("old")
  })

  test("recovers reentrant owners stranded by an in-progress transport failure", async () => {
    const document = session(`<Gallery>
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="first" channel="SharedChannel" />
      <turbo-cable-stream-source id="second" channel="SharedChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })
    let releaseReentrantFirst: (() => void) | undefined
    let releaseSecond: (() => void) | undefined
    cable.subscribeHook = () => {
      cable.subscribeHook = undefined
      releaseSecond = registry.retain(source(document, "second"))
      releaseReentrantFirst = registry.retain(source(document, "first"))
      throw new Error("secret in-progress subscription details")
    }

    expect(() => registry.retain(source(document, "first"))).toThrow(
      new SubscriptionError("Cable stream source subscription failed", {
        target: "id:first",
      }),
    )
    expect(cable.records).toHaveLength(2)
    expect(errors).toEqual([
      new SubscriptionError("Cable stream source subscription failed", {
        target: "id:first",
      }),
    ])
    cable.records[0]?.callbacks.received(
      '<turbo-stream action="update" target="status"><template>stale</template></turbo-stream>',
    )
    expect(text(document, "status")).toBe("old")
    cable.records[1]?.callbacks.received(
      '<turbo-stream action="update" target="status"><template>fresh</template></turbo-stream>',
    )
    expect(text(document, "status")).toBe("fresh")

    releaseSecond?.()
    await flushRelease()
    expect(cable.records[1]?.unsubscribeCalls).toBe(0)
    releaseReentrantFirst?.()
    await flushRelease()
    expect(cable.records[1]?.unsubscribeCalls).toBe(1)
  })

  test("dispatches messages once per shared subscription and recovers after malformed input", () => {
    const document = session(`<Gallery>
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="first" channel="DemoChannel" />
      <turbo-cable-stream-source id="second" channel="DemoChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const reports: string[] = []
    const lifecycleReports: string[] = []
    const streamLifecycle = new StreamLifecycle()
    streamLifecycle.subscribe("stream-action", (event) => {
      lifecycleReports.push(event.detail.report.status)
      return undefined
    })
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
      onMessage: (report) => {
        reports.push(report.actions.map((action) => action.status).join(","))
      },
      streamOptions: { streamLifecycle },
    })
    registry.retain(source(document, "first"))
    registry.retain(source(document, "second"))
    const received = cable.records[0]?.callbacks.received
    if (!received) throw new Error("Missing Cable receiver")

    received("<turbo-stream")
    received(
      '<turbo-stream action="update" target="status"><template>fresh</template></turbo-stream>',
    )

    expect(text(document, "status")).toBe("fresh")
    expect(reports).toEqual(["applied"])
    expect(lifecycleReports).toEqual(["applied"])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(SubscriptionError)
    expect(errors[0]?.message).toBe("Cable stream message dispatch failed")
    expect(errors[0]?.cause).toBeUndefined()
    expect((errors[0] as SubscriptionError).context).toEqual({ target: "id:first" })
  })

  test("routes a decoded Action Cable delivery through the active subscription callback", () => {
    const document = session(`<Gallery>
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="source" channel="DemoChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => {
        throw error
      },
    })
    registry.retain(source(document, "source"))
    const identifier = cable.records[0]?.identifier
    const received = cable.records[0]?.callbacks.received
    if (!identifier || !received) throw new Error("Missing Cable subscription")

    const frame = decodeActionCableV1Frame(
      JSON.stringify({
        identifier,
        message:
          '<turbo-stream action="update" target="status"><template>fresh</template></turbo-stream>',
      }),
    )
    if (!("identifier" in frame && "message" in frame)) {
      throw new Error("Expected Action Cable delivery frame")
    }
    received(frame.message)

    expect(text(document, "status")).toBe("fresh")
  })

  test("serializes reentrant delivery across distinct subscriptions", () => {
    const document = session(`<Gallery>
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="first" channel="FirstChannel" />
      <turbo-cable-stream-source id="second" channel="SecondChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const observations: string[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => {
        throw error
      },
      onMessage: () => observations.push(`report:${text(document, "status")}`),
    })
    registry.retain(source(document, "first"))
    registry.retain(source(document, "second"))
    const first = cable.records.find((record) => record.identifier.includes("FirstChannel"))
    const second = cable.records.find((record) => record.identifier.includes("SecondChannel"))
    if (!first || !second) throw new Error("Missing subscriptions")
    let nested = false
    document.subscribe("id:status", () => {
      observations.push(`listener:${text(document, "status")}`)
      if (nested) return
      nested = true
      second.callbacks.received(
        '<turbo-stream action="update" target="status"><template>second</template></turbo-stream>',
      )
    })

    first.callbacks.received(
      '<turbo-stream action="update" target="status"><template>first</template></turbo-stream>',
    )

    expect(text(document, "status")).toBe("second")
    expect(observations).toEqual([
      "listener:first",
      "report:first",
      "listener:second",
      "report:second",
    ])
  })

  test("isolates a message observer failure from later delivery", () => {
    const document = session(`<Gallery>
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="source" channel="DemoChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    let observations = 0
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
      onMessage: () => {
        observations += 1
        if (observations === 1) throw new Error("secret observer details")
      },
    })
    registry.retain(source(document, "source"))
    const received = cable.records[0]?.callbacks.received
    if (!received) throw new Error("Missing Cable receiver")

    received(
      '<turbo-stream action="update" target="status"><template>first</template></turbo-stream>',
    )
    received(
      '<turbo-stream action="update" target="status"><template>second</template></turbo-stream>',
    )

    expect(text(document, "status")).toBe("second")
    expect(observations).toBe(2)
    expect(errors).toEqual([
      new SubscriptionError("Cable stream source message observer failed", {
        target: "id:source",
      }),
    ])
    expect(errors[0]?.cause).toBeUndefined()
  })

  test("disconnects synchronously on exact-node removal and ignores late callbacks", () => {
    const document = session(`<Gallery id="gallery">
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="source" channel="DemoChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })
    registry.retain(source(document, "source"))
    const record = cable.records[0]
    if (!record) throw new Error("Missing subscription")

    document.mutate((tree) => {
      const current = tree.getElementById("source")
      return current ? tree.removeNode(current) : []
    })

    expect(record.unsubscribeCalls).toBe(1)
    record.callbacks.received(
      '<turbo-stream action="update" target="status"><template>stale</template></turbo-stream>',
    )
    expect(text(document, "status")).toBe("old")
    expect(errors).toEqual([])
  })

  test("suppresses delivery immediately after the final lease releases", async () => {
    const document = session(`<Gallery>
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="source" channel="DemoChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => {
        throw error
      },
    })
    const release = registry.retain(source(document, "source"))
    const record = cable.records[0]
    if (!record) throw new Error("Missing subscription")

    release()
    record.callbacks.received(
      '<turbo-stream action="update" target="status"><template>stale</template></turbo-stream>',
    )

    expect(text(document, "status")).toBe("old")
    expect(record.unsubscribeCalls).toBe(0)
    await flushRelease()
    expect(record.unsubscribeCalls).toBe(1)
  })

  test("keeps zero-owner descriptor changes silent until a source is retained again", async () => {
    const document = session(`<Gallery>
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="source" channel="FirstChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })
    const release = registry.retain(source(document, "source"))
    const first = cable.records[0]
    if (!first) throw new Error("Missing first subscription")

    release()
    document.removeAttribute("id:source", "channel")

    expect(first.unsubscribeCalls).toBe(1)
    expect(errors).toEqual([])
    expect(() => registry.retain(source(document, "source"))).toThrow(
      new SubscriptionError("Cable stream source channel must be a nonblank token", {
        target: "id:source",
      }),
    )
    expect(errors).toEqual([
      new SubscriptionError("Cable stream source channel must be a nonblank token", {
        target: "id:source",
      }),
    ])

    document.setAttribute("id:source", "channel", "RecoveredChannel")
    const releaseRecovered = registry.retain(source(document, "source"))
    expect(cable.records[1]?.identifier).toBe(
      JSON.stringify({ channel: "RecoveredChannel", signed_stream_name: null }),
    )
    cable.records[1]?.callbacks.received(
      '<turbo-stream action="update" target="status"><template>fresh</template></turbo-stream>',
    )
    expect(text(document, "status")).toBe("fresh")

    releaseRecovered()
    await flushRelease()
    expect(cable.records[1]?.unsubscribeCalls).toBe(1)
  })

  test("uses release epochs so an old microtask cannot consume a newer schedule", async () => {
    const document = session(`<Gallery>
      <turbo-cable-stream-source id="source" channel="DemoChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => {
        throw error
      },
    })
    const releaseFirst = registry.retain(source(document, "source"))
    releaseFirst()
    let releaseAfterMicrotask: (() => void) | undefined
    queueMicrotask(() => {
      releaseAfterMicrotask = registry.retain(source(document, "source"))
    })
    const releaseSecond = registry.retain(source(document, "source"))
    releaseSecond()

    await flushRelease()

    expect(cable.records).toHaveLength(1)
    expect(cable.records[0]?.unsubscribeCalls).toBe(0)
    releaseAfterMicrotask?.()
    await flushRelease()
    expect(cable.records[0]?.unsubscribeCalls).toBe(1)
  })

  test("publishes the source before hostile subscribe reentrancy and cleans up once", () => {
    const document = session(`<Gallery id="gallery">
      <turbo-cable-stream-source id="source" channel="DemoChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    cable.subscribeHook = (callbacks) => {
      callbacks.received(
        '<turbo-stream action="remove" target="source"><template /></turbo-stream>',
      )
    }
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })

    const release = registry.retain(source(document, "source"))

    expect(document.tree.getElementById("source")).toBeUndefined()
    expect(cable.records[0]?.unsubscribeCalls).toBe(1)
    expect(errors).toEqual([])
    expect(release()).toBeUndefined()
  })

  test("redacts adapter failures and reports cleanup violations without failing mutation", () => {
    const document = session(`<Gallery>
      <turbo-cable-stream-source id="source" channel="DemoChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    cable.subscribeError = new Error("secret subscribe details")
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })

    let reported: Error | undefined
    try {
      registry.retain(source(document, "source"))
    } catch (error) {
      reported = error as Error
    }
    expect(reported).toEqual(
      new SubscriptionError("Cable stream source subscription failed", {
        target: "id:source",
      }),
    )
    expect(reported?.cause).toBeUndefined()

    cable.subscribeError = undefined
    cable.unsubscribeResult = Promise.resolve("secret async cleanup details")
    registry.retain(source(document, "source"))
    expect(() =>
      document.mutate((tree) => {
        const current = tree.getElementById("source")
        return current ? tree.removeNode(current) : []
      }),
    ).not.toThrow()
    expect(errors).toEqual([
      new SubscriptionError("Cable stream source subscription failed", {
        target: "id:source",
      }),
      new SubscriptionError("Cable stream source unsubscribe failed", {
        target: "id:source",
      }),
    ])
    expect(errors[0]?.cause).toBeUndefined()
  })

  test("rejects and consumes an invalid asynchronous subscription", async () => {
    const document = session(`<Gallery>
      <turbo-cable-stream-source id="source" channel="DemoChannel" />
    </Gallery>`)
    const cable = {
      subscribe() {
        return Promise.reject(new Error("secret asynchronous subscription details"))
      },
    } as unknown as CableAdapter
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: () => undefined,
    })

    expect(() => registry.retain(source(document, "source"))).toThrow(
      new SubscriptionError("Cable adapter returned an invalid subscription", {
        target: "id:source",
      }),
    )
    await Promise.resolve()
  })

  test("rejects stale exact nodes and disposes every active transport", () => {
    const document = session(`<Gallery>
      <turbo-cable-stream-source id="first" channel="FirstChannel" />
      <turbo-cable-stream-source id="second" channel="SecondChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: () => undefined,
    })
    const stale = source(document, "first")
    registry.retain(stale)
    registry.retain(source(document, "second"))
    document.mutate((tree) => {
      const current = tree.getElementById("first")
      if (!current) return []
      return tree.replaceNodeWithClones(
        current,
        parseExpoTurboDocument(
          '<turbo-cable-stream-source id="first" channel="ReplacementChannel" />',
        ).document.children.filter(isElement),
      )
    })

    expect(() => registry.retain(stale)).toThrow(
      new SubscriptionError("Active Cable stream source is missing", { target: "id:first" }),
    )
    registry.retain(source(document, "first"))
    registry.dispose()

    expect(cable.records.map((record) => record.unsubscribeCalls)).toEqual([1, 1, 1])
    expect(() => registry.retain(source(document, "first"))).toThrow(
      new StateError("Cable stream source registry is disposed"),
    )
  })

  test("rejects non-string delivery without poisoning the subscription", () => {
    const document = session(`<Gallery>
      <Status id="status">old</Status>
      <turbo-cable-stream-source id="source" channel="DemoChannel" />
    </Gallery>`)
    const cable = new FakeCable()
    const errors: Error[] = []
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: (error) => errors.push(error),
    })
    registry.retain(source(document, "source"))
    const received = cable.records[0]?.callbacks.received as (message: unknown) => void

    received({ secret: "payload" })
    received(
      '<turbo-stream action="update" target="status"><template>fresh</template></turbo-stream>',
    )

    expect(text(document, "status")).toBe("fresh")
    expect(errors).toEqual([
      new SubscriptionError("Cable stream messages must be strings", {
        target: "id:source",
      }),
    ])
  })

  test("retains source attributes without mutating protocol state", () => {
    const document = session(`<Gallery>
      <turbo-cable-stream-source
        id="source"
        channel="CustomChannel"
        connected=""
        data-room-name="Room 1"
      />
    </Gallery>`)
    const cable = new FakeCable()
    const registry = new CableStreamSourceRegistry(document, cable, {
      onError: () => undefined,
    })
    const node = source(document, "source")

    registry.retain(node)
    cable.records[0]?.callbacks.connected(true)
    cable.records[0]?.callbacks.disconnected()
    cable.records[0]?.callbacks.rejected()

    expect(source(document, "source")).toBe(node)
    expect(attributeValue(node, "connected")).toBe("")
    expect(document.revision).toBe(0)
  })
})
