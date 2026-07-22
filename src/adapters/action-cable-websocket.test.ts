import { describe, expect, test } from "bun:test"

import { SubscriptionError } from "../core/errors"
import {
  ActionCableV1WebSocketAdapter,
  type ActionCableWebSocket,
  type ActionCableWebSocketEventType,
} from "./action-cable-websocket"
import {
  ACTION_CABLE_V1_JSON_PROTOCOL,
  encodeActionCableSubscribe,
  encodeActionCableUnsubscribe,
} from "./action-cable-wire"
import type { CableCallbacks } from "./index"

type Listener = (event: Readonly<{ readonly data?: unknown }>) => void

class FakeSocket implements ActionCableWebSocket {
  closeCalls = 0
  onSend: ((data: string) => void) | undefined
  protocol: string = ACTION_CABLE_V1_JSON_PROTOCOL
  readonly sent: string[] = []
  throwOnSend = false
  private readonly listeners: Record<ActionCableWebSocketEventType, Set<Listener>> = {
    close: new Set(),
    error: new Set(),
    message: new Set(),
    open: new Set(),
  }

  addEventListener(type: ActionCableWebSocketEventType, listener: Listener): void {
    this.listeners[type].add(listener)
  }

  close(): void {
    this.closeCalls += 1
  }

  removeEventListener(type: ActionCableWebSocketEventType, listener: Listener): void {
    this.listeners[type].delete(listener)
  }

  send(data: string): void {
    if (this.throwOnSend) throw new Error("signed-secret")
    this.sent.push(data)
    this.onSend?.(data)
  }

  emitOpen(): void {
    this.emit("open")
  }

  emitClose(): void {
    this.emit("close")
  }

  emitError(): void {
    this.emit("error")
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data })
  }

  private emit(
    type: ActionCableWebSocketEventType,
    event: Readonly<{ readonly data?: unknown }> = {},
  ): void {
    for (const listener of [...this.listeners[type]]) listener(event)
  }
}

function callbackEvents(events: string[], name: string): CableCallbacks {
  return {
    connected(reconnected) {
      events.push(`${name}:connected:${reconnected}`)
    },
    disconnected(willAttemptReconnect) {
      events.push(`${name}:disconnected:${willAttemptReconnect}`)
    },
    received(message) {
      events.push(`${name}:received:${message}`)
    },
    rejected() {
      events.push(`${name}:rejected`)
    },
  }
}

function createAdapter() {
  const errors: SubscriptionError[] = []
  const socketCalls: { protocols: readonly string[]; url: string }[] = []
  const sockets: FakeSocket[] = []
  const adapter = new ActionCableV1WebSocketAdapter({
    createSocket(url, protocols) {
      const socket = new FakeSocket()
      socketCalls.push({ protocols, url })
      sockets.push(socket)
      return socket
    },
    onError(error) {
      errors.push(error)
    },
    url: "wss://cable.example.test/cable",
  })
  return { adapter, errors, socketCalls, sockets }
}

function welcome(socket: FakeSocket): void {
  socket.emitOpen()
  socket.emitMessage('{"type":"welcome"}')
}

function socketAt(sockets: readonly FakeSocket[], index: number): FakeSocket {
  const socket = sockets[index]
  if (!socket) throw new Error("Expected socket")
  return socket
}

function confirmation(socket: FakeSocket, identifier: string): void {
  socket.emitMessage(`{"identifier":${JSON.stringify(identifier)},"type":"confirm_subscription"}`)
}

describe("Action Cable v1 WebSocket adapter", () => {
  test("uses one injected socket, gates commands on welcome, and preserves opaque identifiers", () => {
    const { adapter, errors, socketCalls, sockets } = createAdapter()
    const events: string[] = []
    const first = '{ "signed_stream_name" : "first", "channel" : "Turbo::StreamsChannel" }'
    const second = '{"channel":"Turbo::StreamsChannel","signed_stream_name":"second"}'

    adapter.subscribe(first, callbackEvents(events, "first"))
    adapter.subscribe(second, callbackEvents(events, "second"))

    expect(sockets).toHaveLength(1)
    expect(socketCalls).toEqual([
      { protocols: [ACTION_CABLE_V1_JSON_PROTOCOL], url: "wss://cable.example.test/cable" },
    ])
    expect(sockets[0]?.sent).toEqual([])

    welcome(socketAt(sockets, 0))
    expect(sockets[0]?.sent).toEqual([
      encodeActionCableSubscribe(first),
      encodeActionCableSubscribe(second),
    ])
    expect(events).toEqual([])

    confirmation(socketAt(sockets, 0), second)
    sockets[0]?.emitMessage(`{"identifier":${JSON.stringify(second)},"message":"<turbo-stream/>"}`)
    expect(events).toEqual(["second:connected:false", "second:received:<turbo-stream/>"])
    expect(errors).toEqual([])
  })

  test("shares one server subscription for identical identifiers and joins later consumers immediately", () => {
    const { adapter, sockets } = createAdapter()
    const events: string[] = []
    const identifier = '{"channel":"Turbo::StreamsChannel","signed_stream_name":"shared"}'

    adapter.subscribe(identifier, callbackEvents(events, "first"))
    adapter.subscribe(identifier, callbackEvents(events, "second"))
    welcome(socketAt(sockets, 0))
    expect(sockets[0]?.sent).toEqual([encodeActionCableSubscribe(identifier)])

    confirmation(socketAt(sockets, 0), identifier)
    adapter.subscribe(identifier, callbackEvents(events, "third"))
    sockets[0]?.emitMessage(`{"identifier":${JSON.stringify(identifier)},"message":"update"}`)

    expect(events).toEqual([
      "first:connected:false",
      "second:connected:false",
      "third:connected:false",
      "first:received:update",
      "second:received:update",
      "third:received:update",
    ])
  })

  test("reserves one pending socket across a reentrant factory and closes a socket created after disposal", () => {
    const errors: SubscriptionError[] = []
    const events: string[] = []
    const sockets: FakeSocket[] = []
    let reentered = false
    let adapter: ActionCableV1WebSocketAdapter
    adapter = new ActionCableV1WebSocketAdapter({
      createSocket() {
        if (!reentered) {
          reentered = true
          adapter.subscribe("nested", callbackEvents(events, "nested"))
        }
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      onError(error) {
        errors.push(error)
      },
      url: "wss://cable.example.test/cable",
    })

    adapter.subscribe("outer", callbackEvents(events, "outer"))
    expect(sockets).toHaveLength(1)
    welcome(socketAt(sockets, 0))
    expect(socketAt(sockets, 0).sent).toEqual([
      encodeActionCableSubscribe("outer"),
      encodeActionCableSubscribe("nested"),
    ])
    expect(errors).toEqual([])

    const disposedEvents: string[] = []
    const disposedSocket = new FakeSocket()
    let disposedAdapter: ActionCableV1WebSocketAdapter
    disposedAdapter = new ActionCableV1WebSocketAdapter({
      createSocket() {
        disposedAdapter.dispose()
        return disposedSocket
      },
      onError: () => undefined,
      url: "wss://cable.example.test/cable",
    })

    expect(() =>
      disposedAdapter.subscribe("identifier", callbackEvents(disposedEvents, "disposed")),
    ).toThrow(new SubscriptionError("Action Cable WebSocket adapter is disposed"))
    expect(disposedEvents).toEqual(["disposed:disconnected:false"])
    expect(disposedSocket.closeCalls).toBe(1)
  })

  test("notifies a synchronously confirmed initial subscription once", () => {
    const socket = new FakeSocket()
    const events: string[] = []
    const identifier = '{"channel":"Turbo::StreamsChannel","signed_stream_name":"synchronous"}'
    const addEventListener = socket.addEventListener.bind(socket)
    socket.addEventListener = (type, listener) => {
      addEventListener(type, listener)
      if (type !== "message") return
      socket.emitOpen()
      socket.emitMessage('{"type":"welcome"}')
    }
    socket.onSend = (command) => {
      if (command === encodeActionCableSubscribe(identifier)) confirmation(socket, identifier)
    }
    const adapter = new ActionCableV1WebSocketAdapter({
      createSocket: () => socket,
      onError: () => undefined,
      url: "wss://cable.example.test/cable",
    })

    adapter.subscribe(identifier, callbackEvents(events, "initial"))

    expect(events).toEqual(["initial:connected:false"])
  })

  test("settles queued reentrant subscriptions when a socket factory fails and allows a later retry", () => {
    const errors: SubscriptionError[] = []
    const events: string[] = []
    const sockets: FakeSocket[] = []
    let attempts = 0
    let adapter: ActionCableV1WebSocketAdapter
    adapter = new ActionCableV1WebSocketAdapter({
      createSocket() {
        attempts += 1
        if (attempts === 1) {
          adapter.subscribe("nested", callbackEvents(events, "nested"))
          throw new Error("signed-secret")
        }
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      onError(error) {
        errors.push(error)
      },
      url: "wss://cable.example.test/cable",
    })

    expect(() => adapter.subscribe("outer", callbackEvents(events, "outer"))).toThrow(
      new SubscriptionError("Action Cable WebSocket connection failed"),
    )
    expect(events).toEqual(["nested:disconnected:false"])
    expect(errors).toEqual([new SubscriptionError("Action Cable WebSocket connection failed")])

    adapter.subscribe("retry", callbackEvents(events, "retry"))
    expect(sockets).toHaveLength(1)
  })

  test("keeps a queued reentrant unsubscribe inert when the socket factory fails", () => {
    const errors: SubscriptionError[] = []
    const events: string[] = []
    let adapter: ActionCableV1WebSocketAdapter
    adapter = new ActionCableV1WebSocketAdapter({
      createSocket() {
        const nested = adapter.subscribe("nested", callbackEvents(events, "nested"))
        nested.unsubscribe()
        throw new Error("signed-secret")
      },
      onError(error) {
        errors.push(error)
      },
      url: "wss://cable.example.test/cable",
    })

    expect(() => adapter.subscribe("outer", callbackEvents(events, "outer"))).toThrow(
      new SubscriptionError("Action Cable WebSocket connection failed"),
    )
    expect(events).toEqual([])
    expect(errors).toEqual([])
  })

  test("sends an unsubscribe when a synchronous confirmation removes an identifier", () => {
    const { adapter, sockets } = createAdapter()
    const first = "first"
    const second = "second"
    const events: string[] = []
    let firstSubscription: { unsubscribe(): void } | undefined
    firstSubscription = adapter.subscribe(first, {
      connected() {
        events.push("first:connected")
        firstSubscription?.unsubscribe()
      },
      disconnected: () => undefined,
      received: () => undefined,
      rejected: () => undefined,
    })
    adapter.subscribe(second, callbackEvents(events, "second"))
    const socket = socketAt(sockets, 0)
    socket.onSend = (command) => {
      if (command === encodeActionCableSubscribe(first)) confirmation(socket, first)
    }

    welcome(socket)

    expect(events).toEqual(["first:connected"])
    expect(socket.sent).toEqual([
      encodeActionCableSubscribe(first),
      encodeActionCableUnsubscribe(first),
      encodeActionCableSubscribe(second),
    ])
    expect(socket.closeCalls).toBe(0)
  })

  test("routes only exact active identifiers and rejects a matching subscription without disconnecting others", () => {
    const { adapter, errors, sockets } = createAdapter()
    const events: string[] = []
    const accepted = '{"channel":"Turbo::StreamsChannel","signed_stream_name":"accepted"}'
    const rejected = '{"channel":"Turbo::StreamsChannel","signed_stream_name":"rejected"}'

    adapter.subscribe(accepted, callbackEvents(events, "accepted"))
    adapter.subscribe(rejected, callbackEvents(events, "rejected"))
    welcome(socketAt(sockets, 0))
    confirmation(socketAt(sockets, 0), accepted)
    sockets[0]?.emitMessage(`{"identifier":${JSON.stringify("foreign")},"message":"ignored"}`)
    sockets[0]?.emitMessage(
      `{"identifier":${JSON.stringify(rejected)},"type":"reject_subscription"}`,
    )
    sockets[0]?.emitMessage(`{"identifier":${JSON.stringify(accepted)},"message":"kept"}`)

    expect(events).toEqual([
      "accepted:connected:false",
      "rejected:rejected",
      "accepted:received:kept",
    ])
    expect(errors).toEqual([])
  })

  test("unsubscribes once after welcome, closes when idle, and does not send before welcome", () => {
    const { adapter, sockets } = createAdapter()
    const identifier = '{"channel":"Turbo::StreamsChannel","signed_stream_name":"one"}'
    const beforeWelcome = adapter.subscribe(identifier, callbackEvents([], "before"))

    beforeWelcome.unsubscribe()
    beforeWelcome.unsubscribe()
    expect(sockets[0]?.sent).toEqual([])
    expect(sockets[0]?.closeCalls).toBe(1)

    const afterWelcome = adapter.subscribe(identifier, callbackEvents([], "after"))
    expect(sockets).toHaveLength(2)
    welcome(socketAt(sockets, 1))
    afterWelcome.unsubscribe()
    afterWelcome.unsubscribe()
    expect(sockets[1]?.sent).toEqual([
      encodeActionCableSubscribe(identifier),
      encodeActionCableUnsubscribe(identifier),
    ])
    expect(sockets[1]?.closeCalls).toBe(1)
  })

  test("fails terminally and redacts malformed frames, unsupported protocols, and send failures", () => {
    const malformed = createAdapter()
    const malformedEvents: string[] = []
    malformed.adapter.subscribe(
      '{"channel":"Turbo::StreamsChannel"}',
      callbackEvents(malformedEvents, "one"),
    )
    welcome(socketAt(malformed.sockets, 0))
    malformed.sockets[0]?.emitMessage('{"type":"unknown","secret":"signed-secret"}')
    malformed.sockets[0]?.emitMessage('{"type":"welcome"}')

    expect(malformedEvents).toEqual(["one:disconnected:false"])
    expect(malformed.errors).toEqual([
      new SubscriptionError("Action Cable WebSocket message is invalid"),
    ])
    expect(JSON.stringify(malformed.errors)).not.toContain("signed-secret")
    expect(malformed.sockets[0]?.closeCalls).toBe(1)
    expect(() => malformed.adapter.subscribe("another", callbackEvents([], "two"))).toThrow(
      new SubscriptionError("Action Cable WebSocket adapter is terminated"),
    )

    const protocol = createAdapter()
    const protocolEvents: string[] = []
    protocol.adapter.subscribe("identifier", callbackEvents(protocolEvents, "protocol"))
    socketAt(protocol.sockets, 0).protocol = "unexpected"
    protocol.sockets[0]?.emitOpen()
    expect(protocolEvents).toEqual(["protocol:disconnected:false"])
    expect(protocol.errors).toEqual([
      new SubscriptionError("Action Cable WebSocket protocol is unsupported"),
    ])

    const send = createAdapter()
    const sendEvents: string[] = []
    send.adapter.subscribe("identifier", callbackEvents(sendEvents, "send"))
    socketAt(send.sockets, 0).throwOnSend = true
    welcome(socketAt(send.sockets, 0))
    expect(sendEvents).toEqual(["send:disconnected:false"])
    expect(send.errors).toEqual([new SubscriptionError("Action Cable WebSocket command failed")])
  })

  test("rotates only after a server-directed reconnect and confirms each active record again", () => {
    const { adapter, errors, sockets } = createAdapter()
    const events: string[] = []
    const confirmed = '{"channel":"Turbo::StreamsChannel","signed_stream_name":"confirmed"}'
    const pending = '{"channel":"Turbo::StreamsChannel","signed_stream_name":"pending"}'

    adapter.subscribe(confirmed, callbackEvents(events, "first"))
    adapter.subscribe(confirmed, callbackEvents(events, "second"))
    adapter.subscribe(pending, callbackEvents(events, "pending"))
    const original = socketAt(sockets, 0)
    welcome(original)
    confirmation(original, confirmed)
    adapter.subscribe(confirmed, callbackEvents(events, "late"))
    expect(events).toEqual([
      "first:connected:false",
      "second:connected:false",
      "late:connected:false",
    ])

    original.emitMessage('{"type":"disconnect","reason":"restart","reconnect":true}')

    expect(original.closeCalls).toBe(1)
    expect(sockets).toHaveLength(2)
    const replacement = socketAt(sockets, 1)
    expect(events).toEqual([
      "first:connected:false",
      "second:connected:false",
      "late:connected:false",
      "first:disconnected:true",
      "second:disconnected:true",
      "late:disconnected:true",
      "pending:disconnected:true",
    ])
    expect(replacement.sent).toEqual([])

    original.emitMessage(
      `{"identifier":${JSON.stringify(confirmed)},"message":"late old delivery"}`,
    )
    original.emitClose()
    expect(events).toHaveLength(7)
    expect(errors).toEqual([])

    welcome(replacement)
    expect(replacement.sent).toEqual([
      encodeActionCableSubscribe(confirmed),
      encodeActionCableSubscribe(pending),
    ])
    confirmation(replacement, confirmed)
    confirmation(replacement, pending)

    expect(events).toEqual([
      "first:connected:false",
      "second:connected:false",
      "late:connected:false",
      "first:disconnected:true",
      "second:disconnected:true",
      "late:disconnected:true",
      "pending:disconnected:true",
      "first:connected:true",
      "second:connected:true",
      "late:connected:true",
      "pending:connected:false",
    ])
    expect(errors).toEqual([])
  })

  test("settles a failed server-directed replacement and permits an explicit later subscription", () => {
    const errors: SubscriptionError[] = []
    const events: string[] = []
    const sockets: FakeSocket[] = []
    let attempts = 0
    const adapter = new ActionCableV1WebSocketAdapter({
      createSocket() {
        attempts += 1
        if (attempts === 2) throw new Error("signed-secret")
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      onError(error) {
        errors.push(error)
      },
      url: "wss://cable.example.test/cable",
    })

    adapter.subscribe("identifier", callbackEvents(events, "one"))
    const original = socketAt(sockets, 0)
    welcome(original)
    confirmation(original, "identifier")
    original.emitMessage('{"type":"disconnect","reason":"restart","reconnect":true}')

    expect(events).toEqual([
      "one:connected:false",
      "one:disconnected:true",
      "one:disconnected:false",
    ])
    expect(errors).toEqual([new SubscriptionError("Action Cable WebSocket connection failed")])
    expect(original.closeCalls).toBe(1)

    adapter.subscribe("retry", callbackEvents(events, "retry"))
    expect(sockets).toHaveLength(2)
  })

  test("does not recreate a socket when a reconnect callback removes its final subscription", () => {
    const { adapter, errors, sockets } = createAdapter()
    const events: string[] = []
    let subscription: { unsubscribe(): void } | undefined
    subscription = adapter.subscribe("identifier", {
      connected(reconnected) {
        events.push(`connected:${reconnected}`)
      },
      disconnected(willAttemptReconnect) {
        events.push(`disconnected:${willAttemptReconnect}`)
        if (willAttemptReconnect) subscription?.unsubscribe()
      },
      received: () => undefined,
      rejected: () => undefined,
    })
    const original = socketAt(sockets, 0)
    welcome(original)
    confirmation(original, "identifier")

    original.emitMessage('{"type":"disconnect","reason":"restart","reconnect":true}')

    expect(events).toEqual(["connected:false", "disconnected:true"])
    expect(sockets).toHaveLength(1)
    expect(original.closeCalls).toBe(1)
    expect(errors).toEqual([])
  })

  test("treats a server disconnect without reconnect, socket close, and socket error as terminal", () => {
    for (const terminal of ["disconnect", "close", "error"] as const) {
      const { adapter, errors, sockets } = createAdapter()
      const events: string[] = []
      adapter.subscribe("identifier", callbackEvents(events, terminal))
      welcome(socketAt(sockets, 0))

      switch (terminal) {
        case "disconnect":
          sockets[0]?.emitMessage('{"type":"disconnect","reason":"shutdown","reconnect":false}')
          break
        case "close":
          sockets[0]?.emitClose()
          break
        case "error":
          sockets[0]?.emitError()
          break
      }

      expect(events).toEqual([`${terminal}:disconnected:false`])
      expect(errors).toHaveLength(1)
      expect(() => adapter.subscribe("again", callbackEvents([], "again"))).toThrow(
        new SubscriptionError("Action Cable WebSocket adapter is terminated"),
      )
    }
  })

  test("disposes deterministically and makes late socket events inert", () => {
    const { adapter, errors, sockets } = createAdapter()
    const events: string[] = []
    adapter.subscribe("identifier", callbackEvents(events, "one"))
    welcome(socketAt(sockets, 0))
    confirmation(socketAt(sockets, 0), "identifier")

    adapter.dispose()
    sockets[0]?.emitMessage('{"identifier":"identifier","message":"late"}')
    sockets[0]?.emitClose()
    adapter.dispose()

    expect(events).toEqual(["one:connected:false", "one:disconnected:false"])
    expect(errors).toEqual([])
    expect(sockets[0]?.closeCalls).toBe(1)
    expect(() => adapter.subscribe("again", callbackEvents([], "again"))).toThrow(
      new SubscriptionError("Action Cable WebSocket adapter is disposed"),
    )
  })

  test("consumes unexpected callback and error-observer result rejections", async () => {
    const socket = new FakeSocket()
    const adapter = new ActionCableV1WebSocketAdapter({
      createSocket: () => socket,
      onError: () => Promise.reject(new Error("signed-secret")),
      url: "wss://cable.example.test/cable",
    })
    const callbacks: CableCallbacks = {
      connected: () => undefined,
      disconnected: () => Promise.reject(new Error("signed-secret")),
      received: () => undefined,
      rejected: () => undefined,
    }

    adapter.subscribe("identifier", callbacks)
    socket.emitClose()
    await Promise.resolve()
    await Promise.resolve()

    expect(socket.closeCalls).toBe(1)
  })

  test("validates the host-owned adapter boundary without normalizing the URL", () => {
    expect(
      () =>
        new ActionCableV1WebSocketAdapter({
          createSocket: () => new FakeSocket(),
          onError: () => undefined,
          url: "https://example.test/cable",
        }),
    ).toThrow(new SubscriptionError("Action Cable WebSocket URL must be an absolute ws or wss URL"))
    expect(
      () =>
        new ActionCableV1WebSocketAdapter({
          createSocket: () => new FakeSocket(),
          onError: () => undefined,
          url: "wss://user:password@example.test/cable",
        }),
    ).toThrow(new SubscriptionError("Action Cable WebSocket URL must be an absolute ws or wss URL"))
    expect(
      () =>
        new ActionCableV1WebSocketAdapter({
          createSocket: () => new FakeSocket(),
          onError: () => undefined,
          url: "wss://example.test/cable?ticket=signed-secret",
        }),
    ).toThrow(new SubscriptionError("Action Cable WebSocket URL must be an absolute ws or wss URL"))
  })
})
