import { describe, expect, test } from "bun:test"

import { RequestError, TargetError } from "./errors"
import {
  type BuildFormRequestOptions,
  buildFormRequest,
  FORM_MULTIPART,
  FORM_TEXT_PLAIN,
  FORM_URL_ENCODED,
  MAX_FORM_REQUEST_ENTRIES,
  MAX_FORM_TEXT_PLAIN_BODY_BYTES,
} from "./form-request"
import type { SuccessfulFormEntry } from "./forms"
import { EXPO_TURBO_MIME_TYPE, TURBO_STREAM_MIME_TYPE } from "./protocol-request"

function plan(overrides: Partial<BuildFormRequestOptions> = {}) {
  return buildFormRequest({
    documentUrl: "https://example.test/current/path",
    entries: [],
    form: {},
    protocol: { requestId: "request-1" },
    ...overrides,
  })
}

describe("form request construction", () => {
  test("replaces a GET action query with exact ordered and line-normalized entries", () => {
    const built = plan({
      documentUrl: "https://example.test/current/path?current=1",
      entries: [
        { name: "space plus+~*[]", value: "a b+c%~=*[]" },
        { name: "line\nname", value: "a\rb\r\nc\n" },
        { name: "order[items][]", value: "é😀" },
        { name: "empty", value: "" },
        { name: "empty", value: "again" },
        { name: "", value: "empty-name" },
      ],
      form: { action: "../search?stale=1" },
    })

    expect(built).toMatchObject({
      effectiveMethod: "GET",
      encoding: FORM_URL_ENCODED,
      sourceMethod: "GET",
    })
    expect(built.request).toEqual({
      headers: {
        Accept: EXPO_TURBO_MIME_TYPE,
        "X-Expo-Turbo-Protocol": "0.1",
        "X-Expo-Turbo-Runtime": "0.1.0",
        "X-Turbo-Request-Id": "request-1",
      },
      method: "GET",
      url: "https://example.test/search?space+plus%2B%7E*%5B%5D=a+b%2Bc%25%7E%3D*%5B%5D&line%0D%0Aname=a%0D%0Ab%0D%0Ac%0D%0A&order%5Bitems%5D%5B%5D=%C3%A9%F0%9F%98%80&empty=&empty=again&=empty-name",
    })
  })

  test("clears GET queries and resolves missing or submitter-empty actions to the document", () => {
    expect(plan({ form: { action: "/search?stale=1" } }).request.url).toBe(
      "https://example.test/search",
    )
    expect(
      plan({ documentUrl: "https://example.test/current?stale=1", form: {} }).request.url,
    ).toBe("https://example.test/current")
    expect(
      plan({
        documentUrl: "https://example.test/current?stale=1",
        form: { action: "/ignored" },
        submitter: { action: "" },
      }).request.url,
    ).toBe("https://example.test/current")
  })

  test("adds Stream negotiation for unsafe methods or explicit GET attribute presence", () => {
    const streamAccept = `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`
    const built = plan({
      form: { streamAttributePresent: true },
      protocol: {
        capabilityHash: "sha256:capabilities",
        frameId: "form-frame",
        requestId: "request-stream",
      },
    })

    expect(built.request.headers).toEqual({
      Accept: streamAccept,
      "Turbo-Frame": "form-frame",
      "X-Expo-Turbo-Capabilities": "sha256:capabilities",
      "X-Expo-Turbo-Protocol": "0.1",
      "X-Expo-Turbo-Runtime": "0.1.0",
      "X-Turbo-Request-Id": "request-stream",
    })
    expect(plan({ submitter: { streamAttributePresent: true } }).request.headers.Accept).toBe(
      streamAccept,
    )
    expect(plan().request.headers.Accept).toBe(EXPO_TURBO_MIME_TYPE)
    expect(plan({ form: { method: "post" } }).request.headers.Accept).toBe(streamAccept)
  })

  test("preserves an unsafe action query and builds a URL-encoded POST without _method", () => {
    const built = plan({
      entries: [
        { name: "_method", value: "post" },
        { name: "note", value: "a\nb" },
        { name: "item[]", value: "one two" },
        { name: "_method", value: "patch" },
        { name: "empty", value: "" },
      ],
      form: { action: "/save?keep=1", method: "POST" },
      submitter: { method: "POST" },
    })

    expect(built).toMatchObject({ effectiveMethod: "POST", sourceMethod: "POST" })
    expect(built.entries).toEqual([
      { name: "note", value: "a\r\nb" },
      { name: "item[]", value: "one two" },
      { name: "empty", value: "" },
    ])
    expect(built.request).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "note=a%0D%0Ab&item%5B%5D=one+two&empty=",
      },
      method: "POST",
      url: "https://example.test/save?keep=1",
    })
  })

  test("preserves ordered duplicate and empty names in a URL-encoded POST body", () => {
    const built = plan({
      entries: [
        { name: "first", value: "one" },
        { name: "", value: "empty-name" },
        { name: "first", value: "two" },
        { name: "_charset_", value: "host-owned" },
      ],
      form: { method: "POST" },
    })

    expect(built.entries).toEqual([
      { name: "first", value: "one" },
      { name: "", value: "empty-name" },
      { name: "first", value: "two" },
      { name: "_charset_", value: "host-owned" },
    ])
    expect(built.request.body?.value).toBe("first=one&=empty-name&first=two&_charset_=host-owned")
  })

  test("serializes bounded string entries with the exact HTML text/plain codec", () => {
    const built = plan({
      entries: [
        { name: "", value: "" },
        { name: "duplicate", value: "first" },
        { name: "duplicate", value: "second" },
        { name: "literal=+%", value: "space +%=*[]\u0000\t" },
        { name: "line\n\rname", value: "a\rb\r\nc\n" },
        { name: "unicode", value: "é😀\ud800x\udc00" },
      ],
      form: {
        action: "/save?keep=1",
        enctype: FORM_TEXT_PLAIN,
        method: "POST",
      },
      unsafeMethodTransport: "direct",
    })

    expect(built).toMatchObject({
      effectiveMethod: "POST",
      encoding: FORM_TEXT_PLAIN,
      sourceMethod: "POST",
    })
    expect(built.entries).toEqual([
      { name: "", value: "" },
      { name: "duplicate", value: "first" },
      { name: "duplicate", value: "second" },
      { name: "literal=+%", value: "space +%=*[]\u0000\t" },
      { name: "line\r\n\r\nname", value: "a\r\nb\r\nc\r\n" },
      { name: "unicode", value: "é😀�x�" },
    ])
    expect(built.request).toEqual({
      body: {
        contentType: FORM_TEXT_PLAIN,
        value:
          "=\r\n" +
          "duplicate=first\r\n" +
          "duplicate=second\r\n" +
          "literal=+%=space +%=*[]\u0000\t\r\n" +
          "line\r\n\r\nname=a\r\nb\r\nc\r\n\r\n" +
          "unicode=é😀�x�\r\n",
      },
      headers: {
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "X-Expo-Turbo-Protocol": "0.1",
        "X-Expo-Turbo-Runtime": "0.1.0",
        "X-Turbo-Request-Id": "request-1",
      },
      method: "POST",
      url: "https://example.test/save?keep=1",
    })
  })

  test("supports empty text/plain POST bodies without inventing a record", () => {
    const built = plan({
      form: { enctype: FORM_TEXT_PLAIN, method: "POST" },
    })

    expect(built.request.body).toEqual({
      contentType: FORM_TEXT_PLAIN,
      value: "",
    })
  })

  test("uses submitter text/plain precedence while keeping its named entry last", () => {
    const built = plan({
      entries: [
        { name: "name", value: "Ada" },
        { name: "commit", value: "Save" },
      ],
      form: { enctype: FORM_URL_ENCODED, method: "POST" },
      submitter: {
        enctype: FORM_TEXT_PLAIN,
        name: "commit",
        value: "Save",
      },
    })

    expect(built.encoding).toBe(FORM_TEXT_PLAIN)
    expect(built.entries).toEqual([
      { name: "name", value: "Ada" },
      { name: "commit", value: "Save" },
    ])
    expect(built.request.body).toEqual({
      contentType: FORM_TEXT_PLAIN,
      value: "name=Ada\r\ncommit=Save\r\n",
    })
  })

  test("keeps Rails text/plain POST normalization but rejects body-based method overrides", () => {
    const post = plan({
      entries: [
        { name: "_method", value: "post" },
        { name: "name", value: "Ada" },
      ],
      form: { enctype: FORM_TEXT_PLAIN, method: "POST" },
    })
    expect(post.effectiveMethod).toBe("POST")
    expect(post.entries).toEqual([{ name: "name", value: "Ada" }])
    expect(post.request.method).toBe("POST")
    expect(post.request.body?.value).toBe("name=Ada\r\n")

    for (const options of [
      {
        entries: [] as SuccessfulFormEntry[],
        form: { enctype: FORM_TEXT_PLAIN, method: "PATCH" },
      },
      {
        entries: [{ name: "_method", value: "delete" }],
        form: { enctype: FORM_TEXT_PLAIN, method: "POST" },
      },
    ]) {
      expect(() => plan(options)).toThrow(/method overrides require URL-encoded or multipart/)
    }
  })

  test("keeps _method literal for direct text/plain unsafe requests", () => {
    const built = plan({
      entries: [
        { name: "alpha", value: "1" },
        { name: "_method", value: "post" },
        { name: "_method", value: "delete" },
      ],
      form: { enctype: FORM_TEXT_PLAIN, method: "PATCH" },
      unsafeMethodTransport: "direct",
    })

    expect(built.effectiveMethod).toBe("PATCH")
    expect(built.request.method).toBe("PATCH")
    expect(built.request.body?.value).toBe("alpha=1\r\n_method=post\r\n_method=delete\r\n")
  })

  test("bounds text/plain UTF-8 bodies before joining records", () => {
    const acceptedValue = "a".repeat(MAX_FORM_TEXT_PLAIN_BODY_BYTES - 4)
    const accepted = plan({
      entries: [{ name: "n", value: acceptedValue }],
      form: { enctype: FORM_TEXT_PLAIN, method: "POST" },
      unsafeMethodTransport: "direct",
    })
    const body = accepted.request.body?.value
    if (typeof body !== "string") throw new Error("text form body was not a string")
    expect(body.length).toBe(MAX_FORM_TEXT_PLAIN_BODY_BYTES)

    expect(() =>
      plan({
        entries: [{ name: "n", value: `${acceptedValue}a` }],
        form: { enctype: FORM_TEXT_PLAIN, method: "POST" },
        unsafeMethodTransport: "direct",
      }),
    ).toThrow(/body limit exceeded/)

    expect(() =>
      plan({
        entries: [
          {
            name: "",
            value: "é".repeat(Math.floor(MAX_FORM_TEXT_PLAIN_BODY_BYTES / 2)),
          },
        ],
        form: { enctype: FORM_TEXT_PLAIN, method: "POST" },
        unsafeMethodTransport: "direct",
      }),
    ).toThrow(/body limit exceeded/)
  })

  test("normalizes raw PUT, PATCH, and DELETE to POST plus one Rails override", () => {
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const built = plan({ entries: [{ name: "alpha", value: "1" }], form: { method } })
      expect(built).toMatchObject({ effectiveMethod: method, sourceMethod: method })
      expect(built.request.method).toBe("POST")
      expect(built.request.body?.value).toBe(`alpha=1&_method=${method.toLowerCase()}`)
    }
  })

  test("sends Turbo-generated unsafe link methods directly without interpreting _method", () => {
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const built = plan({
        entries: [
          { name: "alpha", value: "1" },
          { name: "_method", value: "post" },
          { name: "alpha", value: "2" },
          { name: "_method", value: "delete" },
        ],
        form: { method },
        unsafeMethodTransport: "direct",
      })

      expect(built).toMatchObject({ effectiveMethod: method, sourceMethod: method })
      expect(built.entries).toEqual([
        { name: "alpha", value: "1" },
        { name: "_method", value: "post" },
        { name: "alpha", value: "2" },
        { name: "_method", value: "delete" },
      ])
      expect(built.request.method).toBe(method)
      expect(built.request.body?.value).toBe("alpha=1&_method=post&alpha=2&_method=delete")
    }

    const post = plan({
      entries: [{ name: "_method", value: "delete" }],
      form: { method: "POST" },
      unsafeMethodTransport: "direct",
    })
    expect(post.effectiveMethod).toBe("POST")
    expect(post.request.method).toBe("POST")
    expect(post.request.body?.value).toBe("_method=delete")
  })

  test("uses turbo-rails submitter and _method precedence and collapses duplicates", () => {
    const entryOverride = plan({
      entries: [
        { name: "alpha", value: "1" },
        { name: "_method", value: "delete" },
        { name: "beta", value: "2" },
        { name: "_method", value: "patch" },
      ],
      form: { method: "POST" },
    })
    expect(entryOverride.effectiveMethod).toBe("DELETE")
    expect(entryOverride.request.body?.value).toBe("alpha=1&_method=delete&beta=2")

    const submitterMethod = plan({
      entries: [{ name: "_method", value: "patch" }],
      form: { method: "POST" },
      submitter: { method: "POST" },
    })
    expect(submitterMethod.effectiveMethod).toBe("POST")
    expect(submitterMethod.request.body?.value).toBe("")

    const namedSubmitter = plan({
      entries: [
        { name: "_method", value: "patch" },
        { name: "_method", value: "delete" },
      ],
      form: { method: "POST" },
      submitter: { method: "POST", name: "_method", value: "delete" },
    })
    expect(namedSubmitter.effectiveMethod).toBe("DELETE")
    expect(namedSubmitter.request.body?.value).toBe("_method=delete")
  })

  test("requires named submitter metadata to match the final collected entry", () => {
    const built = plan({
      entries: [
        { name: "field", value: "value" },
        { name: "commit", value: "Save" },
      ],
      form: { method: "POST" },
      submitter: { name: "commit", value: "Save" },
    })
    expect(built.request.body?.value).toBe("field=value&commit=Save")

    expect(() =>
      plan({
        entries: [{ name: "field", value: "value" }],
        form: { method: "POST" },
        submitter: { name: "commit", value: "Save" },
      }),
    ).toThrow(RequestError)
    expect(() =>
      plan({
        entries: [{ name: "commit", value: "Different" }],
        form: { method: "POST" },
        submitter: { name: "commit", value: "Save" },
      }),
    ).toThrow(RequestError)
  })

  test("ignores enctype and _method interpretation for GET", () => {
    for (const enctype of [FORM_MULTIPART, FORM_TEXT_PLAIN]) {
      const built = plan({
        entries: [
          { name: "_method", value: "delete" },
          { name: "name", value: "a b" },
        ],
        form: { action: "/search?stale=1", enctype },
      })

      expect(built.encoding).toBe(enctype)
      expect(built.effectiveMethod).toBe("GET")
      expect(built.request).not.toHaveProperty("body")
      expect(built.request.url).toBe("https://example.test/search?_method=delete&name=a+b")
    }
  })

  test("canonicalizes method and enctype attributes with submitter precedence", () => {
    expect(plan({ form: { method: "pAtCh" } }).sourceMethod).toBe("PATCH")
    expect(plan({ form: { method: "TRACE" } }).sourceMethod).toBe("GET")
    expect(plan({ form: { method: "POST" }, submitter: { method: "TRACE" } }).sourceMethod).toBe(
      "GET",
    )

    const invalidSubmitterEncoding = plan({
      form: { enctype: FORM_MULTIPART },
      submitter: { enctype: "application/json" },
    })
    expect(invalidSubmitterEncoding.encoding).toBe(FORM_URL_ENCODED)
    const emptySubmitterEncoding = plan({
      form: { enctype: FORM_TEXT_PLAIN },
      submitter: { enctype: "" },
    })
    expect(emptySubmitterEncoding.encoding).toBe(FORM_TEXT_PLAIN)
  })

  test("rejects fragments until native form navigation owns anchor behavior", () => {
    for (const action of ["/submit#result", "/submit#", "/submit?#"]) {
      expect(() => plan({ form: { action } })).toThrow(TargetError)
      expect(() => plan({ form: { action, method: "POST" } })).toThrow(TargetError)
    }
    expect(plan({ documentUrl: "https://example.test/current#result", form: {} }).request.url).toBe(
      "https://example.test/current",
    )
  })

  test("admits normalized same-origin HTTP(S) actions and rejects every external form", () => {
    expect(plan({ form: { action: "https://example.test:443/save" } }).request.url).toBe(
      "https://example.test/save",
    )

    for (const action of [
      "https://outside.test/save",
      "https://example.test:444/save",
      "http://example.test/save",
      "//outside.test/save",
      "https://user:secret@example.test/save",
      "data:text/plain,save",
      "mailto:help@example.test",
      "http://[",
    ]) {
      expect(() => plan({ form: { action } })).toThrow(TargetError)
    }
  })

  test("rejects unconsumable bodies, malformed Rails overrides, metadata, and entries", () => {
    expect(() => plan({ form: { enctype: FORM_MULTIPART, method: "POST" } })).toThrow(RequestError)
    for (const value of ["", "get", "trace"]) {
      expect(() =>
        plan({ entries: [{ name: "_method", value }], form: { method: "POST" } }),
      ).toThrow(RequestError)
    }
    expect(() => plan({ form: { method: "POST" }, submitter: { name: "_method" } })).toThrow(
      RequestError,
    )
    expect(() =>
      plan({
        form: { streamAttributePresent: false } as unknown as BuildFormRequestOptions["form"],
      }),
    ).toThrow(RequestError)
    expect(() =>
      plan({ entries: [{ name: "count", value: 3 } as unknown as SuccessfulFormEntry] }),
    ).toThrow(RequestError)
    for (const value of [
      new Blob(["binary"]),
      { name: "photo.jpg", type: "image/jpeg", uri: "file:///photo.jpg" },
    ]) {
      expect(() =>
        plan({
          entries: [{ name: "upload", value } as unknown as SuccessfulFormEntry],
          form: { enctype: FORM_TEXT_PLAIN, method: "POST" },
        }),
      ).toThrow(RequestError)
    }
    expect(() => plan({ unsafeMethodTransport: "browser" as never })).toThrow(RequestError)
    expect(() => plan({ entries: Array(1) as unknown as readonly SuccessfulFormEntry[] })).toThrow(
      RequestError,
    )
  })

  test("bounds entry admission and ignores caller iteration or growth", () => {
    const boundary = Array.from({ length: MAX_FORM_REQUEST_ENTRIES }, (_, index) => ({
      name: "entry",
      value: `${index}`,
    }))
    expect(plan({ entries: boundary }).entries).toHaveLength(MAX_FORM_REQUEST_ENTRIES)
    expect(() => plan({ entries: [...boundary, { name: "overflow", value: "1" }] })).toThrow(
      /entry limit exceeded/,
    )
    expect(() =>
      plan({
        entries: boundary,
        form: { method: "PATCH" },
      }),
    ).toThrow(/entry limit exceeded/)

    const customIterator = [{ name: "field", value: "value" }]
    customIterator[Symbol.iterator] = () => {
      throw new Error("custom iterator must not run")
    }
    expect(plan({ entries: customIterator }).entries).toEqual([{ name: "field", value: "value" }])

    const growing: SuccessfulFormEntry[] = []
    Object.defineProperty(growing, 0, {
      configurable: true,
      enumerable: true,
      get() {
        growing.push(...boundary)
        return { name: "first", value: "only" }
      },
    })
    growing.length = 1
    expect(plan({ entries: growing }).entries).toEqual([{ name: "first", value: "only" }])
  })

  test("reads each request entry field once before normalization", () => {
    let nameReads = 0
    let valueReads = 0
    const entry = {
      get name(): unknown {
        nameReads += 1
        return nameReads === 1 ? "field" : { replace: () => ({ uri: "file:///name" }) }
      },
      get value(): unknown {
        valueReads += 1
        return valueReads === 1 ? "admitted" : { replace: () => ({ uri: "file:///value" }) }
      },
    }
    const built = plan({
      entries: [entry] as unknown as readonly SuccessfulFormEntry[],
      form: { method: "POST" },
    })

    expect(built.entries).toEqual([{ name: "field", value: "admitted" }])
    expect(built.request.body?.value).toBe("field=admitted")
    expect({ nameReads, valueReads }).toEqual({ nameReads: 1, valueReads: 1 })
  })

  test("snapshots form and submitter metadata once and redacts getter failures", () => {
    let enctypeReads = 0
    let methodReads = 0
    let nameReads = 0
    let valueReads = 0
    const form = {
      get enctype(): unknown {
        enctypeReads += 1
        return enctypeReads === 1 ? FORM_TEXT_PLAIN : { sensitive: "changed enctype" }
      },
      get method(): unknown {
        methodReads += 1
        return methodReads === 1 ? "POST" : { sensitive: "changed method" }
      },
    }
    const submitter = {
      get name(): unknown {
        nameReads += 1
        return nameReads === 1 ? "commit" : "_method"
      },
      get value(): unknown {
        valueReads += 1
        return valueReads === 1 ? "Save" : "DELETE"
      },
    }
    const built = plan({
      entries: [
        { name: "field", value: "value" },
        { name: "commit", value: "Save" },
      ],
      form: form as BuildFormRequestOptions["form"],
      submitter: submitter as NonNullable<BuildFormRequestOptions["submitter"]>,
    })

    expect(built).toMatchObject({
      effectiveMethod: "POST",
      encoding: FORM_TEXT_PLAIN,
      sourceMethod: "POST",
    })
    expect(built.request.body?.value).toBe("field=value\r\ncommit=Save\r\n")
    expect({ enctypeReads, methodReads, nameReads, valueReads }).toEqual({
      enctypeReads: 1,
      methodReads: 1,
      nameReads: 1,
      valueReads: 1,
    })

    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("sensitive form getter detail")
        },
      },
    )
    try {
      plan({ form: throwing })
      throw new Error("throwing form fixture was accepted")
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      if (!(error instanceof RequestError)) throw error
      expect(`${error.message} ${JSON.stringify(error.context)}`).not.toContain("sensitive")
    }
  })

  test("rejects control characters in protocol headers without echoing their values", () => {
    for (const protocol of [
      { requestId: "" },
      { requestId: "   " },
      { frameId: "", requestId: "request-1" },
      { capabilityHash: "", requestId: "request-1" },
      { requestId: "request\r\nsecret" },
      { frameId: "frame\nsecret", requestId: "request-1" },
      { capabilityHash: "hash\u0000secret", requestId: "request-1" },
    ]) {
      try {
        plan({ protocol })
        throw new Error("header fixture was accepted")
      } catch (error) {
        expect(error).toBeInstanceOf(RequestError)
        if (!(error instanceof RequestError)) throw error
        expect(`${error.message} ${JSON.stringify(error.context)}`).not.toContain("secret")
      }
    }
  })

  test("rejects malformed request signals without relying on realm identity", () => {
    const invalidSignals = [
      null,
      false,
      0,
      "",
      {},
      { aborted: false },
      { aborted: false, addEventListener() {} },
      {
        aborted: "false",
        addEventListener() {},
        removeEventListener() {},
      },
      {
        aborted: false,
        addEventListener() {},
        dispatchEvent() {
          return true
        },
        removeEventListener() {},
      },
      {
        aborted: false,
        addEventListener() {},
        dispatchEvent() {
          return true
        },
        onabort: "invalid",
        removeEventListener() {},
      },
    ]
    for (const signal of invalidSignals) {
      expect(() => plan({ signal: signal as never })).toThrow(RequestError)
    }

    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("sensitive signal detail")
        },
      },
    )
    try {
      plan({ signal: throwing as never })
      throw new Error("throwing signal fixture was accepted")
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      if (!(error instanceof RequestError)) throw error
      expect(`${error.message} ${JSON.stringify(error.context)}`).not.toContain("sensitive")
    }

    // React Native 0.86 installs abort-controller@3, whose AbortSignal has
    // this common surface but not the newer reason/throwIfAborted members.
    const reactNativeCompatible = {
      aborted: false,
      addEventListener() {},
      dispatchEvent() {
        return true
      },
      onabort: null,
      removeEventListener() {},
    } as unknown as AbortSignal
    expect(plan({ signal: reactNativeCompatible }).request.signal).toBe(reactNativeCompatible)
  })

  test("validates URL admission before inspecting sensitive entries", () => {
    const entries = new Proxy([] as SuccessfulFormEntry[], {
      get() {
        throw new Error("sensitive entries were inspected")
      },
    })

    expect(() =>
      plan({ entries, form: { action: "https://user:secret@outside.test/save" } }),
    ).toThrow(TargetError)

    try {
      plan({ form: { action: "https://user:secret@outside.test/save" } })
      throw new Error("credential fixture was accepted")
    } catch (error) {
      expect(error).toBeInstanceOf(TargetError)
      if (!(error instanceof TargetError)) throw error
      expect(`${error.message} ${JSON.stringify(error.context)}`).not.toContain("secret")
    }
  })

  test("copies caller data and deeply freezes every exposed plan record", () => {
    const source = { name: "name", value: "before" }
    const entries: SuccessfulFormEntry[] = [source]
    const controller = new AbortController()
    const built = plan({
      entries,
      form: { method: "POST" },
      signal: controller.signal,
    })

    source.value = "after"
    entries.push({ name: "later", value: "ignored" })

    expect(built.request.body?.value).toBe("name=before")
    expect(built.request.signal).toBe(controller.signal)
    expect(Object.isFrozen(built)).toBe(true)
    expect(Object.isFrozen(built.entries)).toBe(true)
    expect(Object.isFrozen(built.entries[0])).toBe(true)
    expect(Object.isFrozen(built.request)).toBe(true)
    expect(Object.isFrozen(built.request.headers)).toBe(true)
    expect(Object.isFrozen(built.request.body)).toBe(true)
    expect(plan()).not.toBe(plan())
  })
})
