import { describe, expect, test } from "bun:test"

import { SubscriptionError } from "../core/errors"
import {
  ACTION_CABLE_V1_JSON_PROTOCOL,
  decodeActionCableV1Frame,
  encodeActionCableSubscribe,
  encodeActionCableUnsubscribe,
} from "./action-cable-wire"

describe("Action Cable v1 JSON wire codec", () => {
  test("uses the Action Cable v1 JSON subprotocol and preserves opaque identifiers", () => {
    const identifier =
      '{ "signed_stream_name" : "signed-secret", "channel" : "Turbo::StreamsChannel" }'

    expect(ACTION_CABLE_V1_JSON_PROTOCOL).toBe("actioncable-v1-json")
    expect(encodeActionCableSubscribe(identifier)).toBe(
      `{"command":"subscribe","identifier":${JSON.stringify(identifier)}}`,
    )
    expect(encodeActionCableUnsubscribe(identifier)).toBe(
      `{"command":"unsubscribe","identifier":${JSON.stringify(identifier)}}`,
    )
    expect(JSON.parse(encodeActionCableSubscribe(identifier)).identifier).toBe(identifier)
  })

  test("decodes every Action Cable server frame shape", () => {
    const identifier = '{"channel":"Turbo::StreamsChannel","signed_stream_name":"signed-secret"}'
    const frames = [
      ['{"type":"welcome"}', { type: "welcome" }],
      ['{"type":"ping","message":1}', { type: "ping", message: 1 }],
      [
        '{"type":"disconnect","reason":null,"reconnect":true}',
        { type: "disconnect", reason: null, reconnect: true },
      ],
      [
        '{"type":"disconnect","reason":"server_restart","reconnect":false}',
        { type: "disconnect", reason: "server_restart", reconnect: false },
      ],
      [
        `{"identifier":${JSON.stringify(identifier)},"type":"confirm_subscription"}`,
        { type: "confirm_subscription", identifier },
      ],
      [
        `{"identifier":${JSON.stringify(identifier)},"type":"reject_subscription"}`,
        { type: "reject_subscription", identifier },
      ],
      [
        `{"identifier":${JSON.stringify(identifier)},"message":"<turbo-stream/>"}`,
        { identifier, message: "<turbo-stream/>" },
      ],
    ] as const

    for (const [raw, expected] of frames) {
      const frame = decodeActionCableV1Frame(raw)
      expect(frame).toEqual(expected)
      expect(Object.isFrozen(frame)).toBe(true)
    }
  })

  test("fails closed without exposing malformed server frames", () => {
    const secret = "signed-secret"
    const invalidFrames = [
      "not JSON",
      "null",
      "[]",
      '{"type":"unknown","secret":"signed-secret"}',
      '{"type":"ping","message":"one"}',
      '{"type":"disconnect","reason":null}',
      '{"type":"confirm_subscription"}',
      '{"type":"reject_subscription","identifier":false}',
      '{"identifier":"signed-secret","message":false}',
    ]

    for (const raw of invalidFrames) {
      try {
        decodeActionCableV1Frame(raw)
        throw new Error("Expected invalid Action Cable frame")
      } catch (error) {
        expect(error).toEqual(new SubscriptionError("Action Cable frame is invalid"))
        expect(error).not.toHaveProperty("cause")
        expect(JSON.stringify(error)).not.toContain(secret)
      }
    }
  })
})
