import { describe, expect, test } from "bun:test"

import type { RestorationIdentifierAdapter } from "../adapters"
import { DocumentHistory } from "./document-history"
import { PropsError, StateError } from "./errors"

function identifiers(
  ...values: string[]
): RestorationIdentifierAdapter & { readonly calls: number } {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    next() {
      const value = values[calls]
      calls += 1
      if (value === undefined) throw new Error("identifier fixture exhausted")
      return value
    },
  }
}

describe("document history", () => {
  test("initializes unmanaged host state with a normalized frozen replacement entry", () => {
    const ids = identifiers("restoration-1")
    const history = new DocumentHistory(ids)

    const initialized = history.initialize({
      kind: "unmanaged",
      url: "https://example.test:443/gallery?filter=active#details",
    })

    expect(initialized).toEqual({
      entry: {
        restorationIdentifier: "restoration-1",
        restorationIndex: 0,
        url: "https://example.test/gallery?filter=active#details",
      },
      hostReplacementRequired: true,
    })
    expect(history.current).toBe(initialized.entry)
    expect(ids.calls).toBe(1)
    expect(Object.isFrozen(initialized)).toBe(true)
    expect(Object.isFrozen(initialized.entry)).toBe(true)
  })

  test("adopts managed host state without consuming an identifier", () => {
    const ids = identifiers("unused")
    const history = new DocumentHistory(ids)
    const source = {
      restorationIdentifier: "persisted",
      restorationIndex: 7,
      url: "https://example.test:443/current#section",
    }

    const initialized = history.initialize({ entry: source, kind: "managed" })

    expect(initialized).toEqual({
      entry: {
        restorationIdentifier: "persisted",
        restorationIndex: 7,
        url: "https://example.test/current#section",
      },
      hostReplacementRequired: false,
    })
    expect(initialized.entry).not.toBe(source)
    expect(ids.calls).toBe(0)
    source.url = "https://example.test/mutated"
    expect(initialized.entry.url).toBe("https://example.test/current#section")
  })

  test("initializes exactly once and leaves the original entry current", () => {
    const ids = identifiers("first", "unused")
    const history = new DocumentHistory(ids)
    const first = history.initialize({ kind: "unmanaged", url: "https://example.test/first" })

    expect(() =>
      history.initialize({ kind: "unmanaged", url: "https://example.test/second" }),
    ).toThrow(StateError)
    expect(history.current).toBe(first.entry)
    expect(ids.calls).toBe(1)
  })

  test("proposes and commits a different-location advance as a frozen push", () => {
    const ids = identifiers("initial", "pushed")
    const history = new DocumentHistory(ids)
    const initialized = history.initialize({
      kind: "unmanaged",
      url: "https://example.test/current",
    })

    const proposal = history.proposeAdvance("https://example.test:443/next#details")

    expect(proposal.entry).toEqual({
      restorationIdentifier: "pushed",
      restorationIndex: 1,
      url: "https://example.test/next#details",
    })
    expect(proposal.method).toBe("push")
    expect(Object.isFrozen(proposal)).toBe(true)
    expect(Object.isFrozen(proposal.entry)).toBe(true)
    expect(history.current).toBe(initialized.entry)
    expect(() => history.getRestorationData("pushed")).toThrow(StateError)

    expect(history.commitProposal(proposal)).toBe(proposal.entry)
    expect(history.current).toBe(proposal.entry)
    expect(history.getRestorationData("pushed")).toEqual({})
  })

  test("uses replace for a same-location advance and an explicit replacement", () => {
    const ids = identifiers("initial", "same-location", "explicit-replace")
    const history = new DocumentHistory(ids)
    history.initialize({
      kind: "unmanaged",
      url: "https://example.test/current?filter=active#details",
    })

    const sameLocation = history.proposeAdvance(
      "https://example.test:443/current?filter=active#details",
    )
    expect(sameLocation.entry).toEqual({
      restorationIdentifier: "same-location",
      restorationIndex: 0,
      url: "https://example.test/current?filter=active#details",
    })
    expect(sameLocation.method).toBe("replace")
    history.commitProposal(sameLocation)

    const explicit = history.proposeReplace("https://example.test/replaced")
    expect(explicit.entry).toEqual({
      restorationIdentifier: "explicit-replace",
      restorationIndex: 0,
      url: "https://example.test/replaced",
    })
    expect(explicit.method).toBe("replace")
    history.commitProposal(explicit)
    expect(history.current).toBe(explicit.entry)
  })

  test("retargets redirects without changing the requested-location history method", () => {
    const ids = identifiers("initial", "advance", "same-location")
    const history = new DocumentHistory(ids)
    history.initialize({ kind: "unmanaged", url: "https://example.test/current" })

    const advance = history.proposeAdvance("https://example.test/start")
    const redirectedToCurrent = history.retargetProposal(advance, "https://example.test/current")
    expect(redirectedToCurrent.entry).toEqual({
      restorationIdentifier: "advance",
      restorationIndex: 1,
      url: "https://example.test/current",
    })
    expect(redirectedToCurrent.method).toBe("push")
    expect(() => history.commitProposal(advance)).toThrow(StateError)
    expect(history.current?.restorationIndex).toBe(0)
    history.commitProposal(redirectedToCurrent)

    const sameLocation = history.proposeAdvance("https://example.test/current")
    const redirectedAway = history.retargetProposal(sameLocation, "https://example.test/redirected")
    expect(redirectedAway.entry).toEqual({
      restorationIdentifier: "same-location",
      restorationIndex: 1,
      url: "https://example.test/redirected",
    })
    expect(redirectedAway.method).toBe("replace")
    history.commitProposal(redirectedAway)
    expect(history.current).toBe(redirectedAway.entry)
  })

  test("rejects forged, stale, and already-settled proposals atomically", () => {
    const history = new DocumentHistory(identifiers("initial", "first", "second"))
    history.initialize({ kind: "unmanaged", url: "https://example.test/current" })
    const first = history.proposeAdvance("https://example.test/first")
    const second = history.proposeAdvance("https://example.test/second")

    history.commitProposal(second)
    expect(() => history.commitProposal(first)).toThrow("Document history proposal is stale")
    expect(() => history.commitProposal(second)).toThrow(StateError)
    expect(() =>
      history.commitProposal({ entry: second.entry, method: second.method } as never),
    ).toThrow(StateError)
    expect(history.current).toBe(second.entry)
    expect(() => history.getRestorationData("first")).toThrow(StateError)
  })

  test("rejects push overflow before consuming an identifier", () => {
    const ids = identifiers("replacement")
    const history = new DocumentHistory(ids)
    history.initialize({
      entry: {
        restorationIdentifier: "current",
        restorationIndex: Number.MAX_SAFE_INTEGER,
        url: "https://example.test/current",
      },
      kind: "managed",
    })

    expect(() => history.proposeAdvance("https://example.test/next")).toThrow(StateError)
    expect(ids.calls).toBe(0)

    const replacement = history.proposeAdvance("https://example.test/current")
    expect(replacement.method).toBe("replace")
    expect(replacement.entry.restorationIndex).toBe(Number.MAX_SAFE_INTEGER)
    expect(ids.calls).toBe(1)
  })

  test("keeps the ledger and original proposal intact when retargeting fails", () => {
    const history = new DocumentHistory(identifiers("initial", "advance"))
    const initialized = history.initialize({
      kind: "unmanaged",
      url: "https://example.test/current",
    })
    const proposal = history.proposeAdvance("https://example.test/next")
    let error: unknown

    try {
      history.retargetProposal(proposal, "https://user:secret@example.test/private")
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(StateError)
    expect(String(error)).not.toContain("secret")
    expect(history.current).toBe(initialized.entry)
    history.commitProposal(proposal)
    expect(history.current).toBe(proposal.entry)
  })

  test("rejects invalid, reused, and failed generated identifiers without mutation", () => {
    for (const next of [
      () => " ",
      () => "current",
      () => {
        throw new Error("identifier generation failed")
      },
    ]) {
      const history = new DocumentHistory({ next })
      const initialized = history.initialize({
        entry: {
          restorationIdentifier: "current",
          restorationIndex: 3,
          url: "https://example.test/current",
        },
        kind: "managed",
      })

      expect(() => history.proposeAdvance("https://example.test/next")).toThrow()
      expect(history.current).toBe(initialized.entry)
      expect(history.getRestorationData("current")).toEqual({})
    }
  })

  test("binds identifiers without treating a shared restoration index as a collision", () => {
    const history = new DocumentHistory(identifiers("initial"))
    history.initialize({ kind: "unmanaged", url: "https://example.test/initial" })

    expect(
      history.adoptTraversal({
        restorationIdentifier: "replacement",
        restorationIndex: 0,
        url: "https://example.test/replaced",
      }),
    ).toBe("back")
    expect(history.current).toEqual({
      restorationIdentifier: "replacement",
      restorationIndex: 0,
      url: "https://example.test/replaced",
    })
  })

  test("derives Turbo traversal direction across normalized entries", () => {
    const history = new DocumentHistory(identifiers("current"))
    history.initialize({ kind: "unmanaged", url: "https://example.test/current" })

    expect(
      history.adoptTraversal({
        restorationIdentifier: "forward",
        restorationIndex: 2,
        url: "https://example.test/forward",
      }),
    ).toBe("forward")
    expect(
      history.adoptTraversal({
        restorationIdentifier: "back",
        restorationIndex: 1,
        url: "https://example.test/back",
      }),
    ).toBe("back")
    expect(
      history.adoptTraversal({
        restorationIdentifier: "forward",
        restorationIndex: 2,
        url: "https://example.test:443/forward",
      }),
    ).toBe("forward")
    expect(history.current?.restorationIdentifier).toBe("forward")
  })

  test("shares restoration data when a promoted Frame reuses one identifier", () => {
    const history = new DocumentHistory(identifiers("current"))
    history.initialize({ kind: "unmanaged", url: "https://example.test/current" })
    history.updateRestorationData("current", { scrollPosition: { x: 3, y: 9 } })

    expect(
      history.adoptTraversal({
        restorationIdentifier: "current",
        restorationIndex: 2,
        url: "https://example.test/frame/second",
      }),
    ).toBe("forward")
    expect(history.getRestorationData("current")).toEqual({
      scrollPosition: { x: 3, y: 9 },
    })
    expect(
      history.adoptTraversal({
        restorationIdentifier: "current",
        restorationIndex: 1,
        url: "https://example.test/frame/first",
      }),
    ).toBe("back")
    expect(history.current?.url).toBe("https://example.test/frame/first")
    expect(history.getRestorationData("current")).toEqual({
      scrollPosition: { x: 3, y: 9 },
    })
  })

  test("keeps frozen restoration data independent per bound identifier", () => {
    const history = new DocumentHistory(identifiers("first"))
    history.initialize({ kind: "unmanaged", url: "https://example.test/shared" })
    history.adoptTraversal({
      restorationIdentifier: "second",
      restorationIndex: 0,
      url: "https://example.test/shared",
    })
    const source = { scrollPosition: { x: -4, y: 12 } }

    const second = history.updateRestorationData("second", source)
    source.scrollPosition.x = 100

    expect(second).toEqual({ scrollPosition: { x: -4, y: 12 } })
    expect(Object.isFrozen(second)).toBe(true)
    expect(Object.isFrozen(second.scrollPosition)).toBe(true)
    expect(history.getRestorationData("first")).toEqual({})
    expect(Object.isFrozen(history.getRestorationData("first"))).toBe(true)
    expect(history.getRestorationData("second")).toBe(second)

    history.adoptTraversal({
      restorationIdentifier: "first",
      restorationIndex: 0,
      url: "https://example.test/shared",
    })
    expect(history.getRestorationData("second")).toBe(second)
  })

  test("rejects unbound identifiers and invalid restoration patches atomically", () => {
    const history = new DocumentHistory(identifiers("current"))
    history.initialize({ kind: "unmanaged", url: "https://example.test/current" })

    expect(() => history.getRestorationData("missing")).toThrow(StateError)
    for (const patch of [
      null,
      { extra: true },
      { scrollPosition: undefined },
      { scrollPosition: { x: 0 } },
      { scrollPosition: { x: Number.NaN, y: 0 } },
      { scrollPosition: { x: 0, y: Number.POSITIVE_INFINITY } },
      { scrollPosition: { x: 0, y: 0, z: 0 } },
    ]) {
      expect(() => history.updateRestorationData("current", patch as never)).toThrow(PropsError)
      expect(history.getRestorationData("current")).toEqual({})
    }
  })

  test("rejects malformed or unsafe state without exposing its value", () => {
    const invalidStates = [
      null,
      { kind: "unknown", url: "https://example.test" },
      { kind: "unmanaged", url: "" },
      { kind: "unmanaged", url: "/relative" },
      { kind: "unmanaged", url: "javascript:alert(1)" },
      { kind: "unmanaged", url: "https://user:secret@example.test/private" },
      {
        entry: {
          restorationIdentifier: "",
          restorationIndex: 0,
          url: "https://example.test",
        },
        kind: "managed",
      },
      {
        entry: {
          restorationIdentifier: "id",
          restorationIndex: -1,
          url: "https://example.test",
        },
        kind: "managed",
      },
      {
        entry: {
          restorationIdentifier: "id",
          restorationIndex: 0.5,
          url: "https://example.test",
        },
        kind: "managed",
      },
      {
        entry: {
          restorationIdentifier: "id",
          restorationIndex: Number.MAX_SAFE_INTEGER + 1,
          url: "https://example.test",
        },
        kind: "managed",
      },
    ]

    for (const state of invalidStates) {
      const history = new DocumentHistory(identifiers("generated"))
      let error: unknown
      try {
        history.initialize(state as never)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(StateError)
      expect(String(error)).not.toContain("secret")
      expect(history.current).toBeUndefined()
    }
  })

  test("rejects untrusted traversal entries atomically before binding them", () => {
    const history = new DocumentHistory(identifiers("current"))
    const initialized = history.initialize({
      kind: "unmanaged",
      url: "https://example.test/current",
    })
    const invalidEntries = [
      {
        restorationIdentifier: "relative",
        restorationIndex: 1,
        url: "/relative",
      },
      {
        restorationIdentifier: "credentialed",
        restorationIndex: 1,
        url: "https://user:secret@example.test/private",
      },
      {
        restorationIdentifier: " ",
        restorationIndex: 1,
        url: "https://example.test/blank",
      },
      {
        restorationIdentifier: "fractional",
        restorationIndex: 1.5,
        url: "https://example.test/fractional",
      },
      {
        extra: true,
        restorationIdentifier: "extra",
        restorationIndex: 1,
        url: "https://example.test/extra",
      },
    ]

    for (const entry of invalidEntries) {
      let error: unknown
      try {
        history.adoptTraversal(entry as never)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(StateError)
      expect(String(error)).not.toContain("secret")
      expect(history.current).toBe(initialized.entry)
      if (entry.restorationIdentifier.trim() !== "") {
        expect(() => history.getRestorationData(entry.restorationIdentifier)).toThrow(StateError)
      }
    }

    expect(
      history.adoptTraversal({
        restorationIdentifier: "credentialed",
        restorationIndex: 1,
        url: "https://example.test/admitted",
      }),
    ).toBe("forward")
    expect(history.getRestorationData("credentialed")).toEqual({})
  })

  test("rejects an invalid generated restoration identifier atomically", () => {
    const history = new DocumentHistory(identifiers("  "))

    expect(() =>
      history.initialize({ kind: "unmanaged", url: "https://example.test/current" }),
    ).toThrow(StateError)
    expect(history.current).toBeUndefined()
  })

  test("leaves unmanaged initialization untouched when identifier generation fails", () => {
    const history = new DocumentHistory({
      next() {
        throw new Error("identifier generation failed")
      },
    })

    expect(() =>
      history.initialize({ kind: "unmanaged", url: "https://example.test/current" }),
    ).toThrow("identifier generation failed")
    expect(history.current).toBeUndefined()
  })

  test("requires initialization before traversal", () => {
    const history = new DocumentHistory(identifiers("unused"))
    expect(() =>
      history.adoptTraversal({
        restorationIdentifier: "target",
        restorationIndex: 1,
        url: "https://example.test/target",
      }),
    ).toThrow(StateError)
  })
})
