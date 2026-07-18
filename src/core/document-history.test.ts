import { describe, expect, test } from "bun:test"

import type { RestorationIdentifierAdapter } from "../adapters"
import {
  DocumentHistory,
  type DocumentHistoryEntry,
  type DocumentHistoryHostAdapter,
  type DocumentHistoryWriteMethod,
} from "./document-history"
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

function historyHost(
  write: (method: DocumentHistoryWriteMethod, entry: DocumentHistoryEntry) => undefined = () =>
    undefined,
): DocumentHistoryHostAdapter & {
  readonly calls: ReadonlyArray<
    Readonly<{ readonly entry: DocumentHistoryEntry; readonly method: DocumentHistoryWriteMethod }>
  >
} {
  const calls: Array<
    Readonly<{ readonly entry: DocumentHistoryEntry; readonly method: DocumentHistoryWriteMethod }>
  > = []
  return {
    calls,
    write(method, entry) {
      calls.push(Object.freeze({ entry, method }))
      return write(method, entry)
    },
  }
}

function createHistory(
  ids: RestorationIdentifierAdapter,
  host: DocumentHistoryHostAdapter = historyHost(),
): DocumentHistory {
  return new DocumentHistory(ids, host)
}

describe("document history", () => {
  test("initializes unmanaged host state with a normalized frozen replacement entry", () => {
    const ids = identifiers("restoration-1")
    let history: DocumentHistory
    const host = historyHost((_method, entry) => {
      expect(history.current).toBeUndefined()
      expect(Object.isFrozen(entry)).toBe(true)
    })
    history = createHistory(ids, host)

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
      hostState: "replaced",
    })
    expect(host.calls).toEqual([{ entry: initialized.entry, method: "replace" }])
    expect(history.current).toBe(initialized.entry)
    expect(ids.calls).toBe(1)
    expect(Object.isFrozen(initialized)).toBe(true)
    expect(Object.isFrozen(initialized.entry)).toBe(true)
  })

  test("adopts managed host state without consuming an identifier", () => {
    const ids = identifiers("unused")
    const host = historyHost()
    const history = createHistory(ids, host)
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
      hostState: "adopted",
    })
    expect(host.calls).toEqual([])
    expect(initialized.entry).not.toBe(source)
    expect(ids.calls).toBe(0)
    source.url = "https://example.test/mutated"
    expect(initialized.entry.url).toBe("https://example.test/current#section")
  })

  test("initializes exactly once and leaves the original entry current", () => {
    const ids = identifiers("first", "unused")
    const history = createHistory(ids)
    const first = history.initialize({ kind: "unmanaged", url: "https://example.test/first" })

    expect(() =>
      history.initialize({ kind: "unmanaged", url: "https://example.test/second" }),
    ).toThrow(StateError)
    expect(history.current).toBe(first.entry)
    expect(ids.calls).toBe(1)
  })

  test("blocks reentrant initialization while generating an unmanaged identifier", () => {
    let history: DocumentHistory
    const reentrantErrors: unknown[] = []
    const host = historyHost((_method, entry) => {
      expect(history.current).toBeUndefined()
      expect(entry.restorationIdentifier).toBe("outer")
    })
    history = createHistory(
      {
        next() {
          try {
            history.initialize({
              entry: {
                restorationIdentifier: "nested",
                restorationIndex: 9,
                url: "https://example.test/nested",
              },
              kind: "managed",
            })
          } catch (error) {
            reentrantErrors.push(error)
          }
          return "outer"
        },
      },
      host,
    )

    const initialized = history.initialize({
      kind: "unmanaged",
      url: "https://example.test/current",
    })

    expect(reentrantErrors).toHaveLength(1)
    expect(reentrantErrors[0]).toBeInstanceOf(StateError)
    expect(String(reentrantErrors[0])).toContain(
      "Document history cannot mutate during another mutation",
    )
    expect(host.calls).toEqual([{ entry: initialized.entry, method: "replace" }])
    expect(history.current).toBe(initialized.entry)
    expect(() => history.getRestorationData("nested")).toThrow(StateError)
  })

  test("keeps unmanaged initialization retryable until the host replacement succeeds", () => {
    const ids = identifiers("failed", "retry")
    let attempts = 0
    const host = historyHost(() => {
      attempts += 1
      if (attempts === 1) throw new Error("host replacement failed with secret-token")
    })
    const history = createHistory(ids, host)

    try {
      history.initialize({ kind: "unmanaged", url: "https://example.test/current" })
      throw new Error("expected host replacement to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(StateError)
      expect(String(error)).not.toContain("secret-token")
    }
    expect(history.current).toBeUndefined()
    expect(ids.calls).toBe(1)

    const initialized = history.initialize({
      kind: "unmanaged",
      url: "https://example.test/current",
    })
    expect(initialized.entry.restorationIdentifier).toBe("retry")
    expect(initialized.hostState).toBe("replaced")
    expect(history.current).toBe(initialized.entry)
    expect(ids.calls).toBe(2)
    expect(host.calls.map(({ entry }) => entry.restorationIdentifier)).toEqual(["failed", "retry"])
  })

  test("proposes and commits a different-location advance as a frozen push", () => {
    const ids = identifiers("initial", "pushed")
    const observedCurrent: Array<DocumentHistoryEntry | undefined> = []
    let history: DocumentHistory
    const host = historyHost(() => {
      observedCurrent.push(history.current)
    })
    history = createHistory(ids, host)
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
    expect(host.calls).toEqual([
      { entry: initialized.entry, method: "replace" },
      { entry: proposal.entry, method: "push" },
    ])
    expect(observedCurrent).toEqual([undefined, initialized.entry])
  })

  test("keeps a host-rejected proposal exact, unbound, and retryable", () => {
    let proposalWrites = 0
    const host = historyHost((method) => {
      if (method !== "push") return
      proposalWrites += 1
      if (proposalWrites === 1) throw new Error("host proposal failed with secret-token")
    })
    const history = createHistory(identifiers("initial", "next"), host)
    const initialized = history.initialize({
      kind: "unmanaged",
      url: "https://example.test/current",
    })
    const proposal = history.proposeAdvance("https://example.test/next")

    try {
      history.commitProposal(proposal)
      throw new Error("expected host proposal write to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(StateError)
      expect(String(error)).not.toContain("secret-token")
    }
    expect(history.current).toBe(initialized.entry)
    expect(() => history.getRestorationData("next")).toThrow(StateError)

    expect(history.commitProposal(proposal)).toBe(proposal.entry)
    expect(history.current).toBe(proposal.entry)
    expect(host.calls.slice(1)).toEqual([
      { entry: proposal.entry, method: "push" },
      { entry: proposal.entry, method: "push" },
    ])
  })

  test("uses replace for a same-location advance and an explicit replacement", () => {
    const ids = identifiers("initial", "same-location", "explicit-replace")
    const host = historyHost()
    const history = createHistory(ids, host)
    const initialized = history.initialize({
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
    expect(host.calls).toEqual([
      { entry: initialized.entry, method: "replace" },
      { entry: sameLocation.entry, method: "replace" },
      { entry: explicit.entry, method: "replace" },
    ])
  })

  test("reuses one exact Frame scope identifier while preserving promoted history semantics", () => {
    const ids = identifiers("initial", "frame-one", "frame-two")
    const host = historyHost()
    const history = createHistory(ids, host)
    const firstFrame = {}
    const secondFrame = {}
    const initialized = history.initialize({
      kind: "unmanaged",
      url: "https://example.test/current",
    })

    const sameLocationAdvance = history.proposeFrameAdvance(
      firstFrame,
      "https://example.test:443/current",
    )
    expect(sameLocationAdvance.entry).toEqual({
      restorationIdentifier: "frame-one",
      restorationIndex: 1,
      url: "https://example.test/current",
    })
    expect(sameLocationAdvance.method).toBe("push")
    history.commitProposal(sameLocationAdvance)

    const replacement = history.proposeFrameReplace(
      firstFrame,
      "https://example.test/frame/replaced",
    )
    expect(replacement.entry).toEqual({
      restorationIdentifier: "frame-one",
      restorationIndex: 1,
      url: "https://example.test/frame/replaced",
    })
    expect(replacement.method).toBe("replace")
    history.commitProposal(replacement)

    const advance = history.proposeFrameAdvance(firstFrame, "https://example.test/frame/requested")
    const redirected = history.retargetProposal(advance, "https://example.test/frame/final")
    expect(redirected.entry).toEqual({
      restorationIdentifier: "frame-one",
      restorationIndex: 2,
      url: "https://example.test/frame/final",
    })
    expect(redirected.method).toBe("push")
    expect(() => history.commitProposal(advance)).toThrow(StateError)
    history.commitProposal(redirected)

    const distinctScope = history.proposeFrameReplace(
      secondFrame,
      "https://example.test/frame/second",
    )
    expect(distinctScope.entry).toEqual({
      restorationIdentifier: "frame-two",
      restorationIndex: 2,
      url: "https://example.test/frame/second",
    })
    history.commitProposal(distinctScope)

    expect(ids.calls).toBe(3)
    expect(host.calls).toEqual([
      { entry: initialized.entry, method: "replace" },
      { entry: sameLocationAdvance.entry, method: "push" },
      { entry: replacement.entry, method: "replace" },
      { entry: redirected.entry, method: "push" },
      { entry: distinctScope.entry, method: "replace" },
    ])
  })

  test("prevents normal proposals from consuming an identifier reserved by a Frame scope", () => {
    const ids = identifiers("initial", "frame", "frame")
    const history = createHistory(ids)
    const initialized = history.initialize({
      kind: "unmanaged",
      url: "https://example.test/current",
    })
    const frameProposal = history.proposeFrameAdvance({}, "https://example.test/frame")

    expect(() => history.proposeAdvance("https://example.test/normal")).toThrow(
      "Generated document restoration identifier is already bound",
    )
    expect(history.current).toBe(initialized.entry)
    expect(() => history.getRestorationData("frame")).toThrow(StateError)
    expect(ids.calls).toBe(3)

    history.commitProposal(frameProposal)
    expect(history.current).toBe(frameProposal.entry)
    expect(history.getRestorationData("frame")).toEqual({})
  })

  test("keeps a host-rejected Frame proposal exact, reserved, and retryable", () => {
    let frameWrites = 0
    const host = historyHost((method) => {
      if (method !== "push") return
      frameWrites += 1
      if (frameWrites === 1) throw new Error("host Frame write failed with secret-token")
    })
    const ids = identifiers("initial", "frame")
    const history = createHistory(ids, host)
    const frameScope = {}
    const initialized = history.initialize({
      kind: "unmanaged",
      url: "https://example.test/current",
    })
    const proposal = history.proposeFrameAdvance(frameScope, "https://example.test/frame")

    try {
      history.commitProposal(proposal)
      throw new Error("expected host Frame write to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(StateError)
      expect(String(error)).not.toContain("secret-token")
    }
    expect(history.current).toBe(initialized.entry)
    expect(() => history.getRestorationData("frame")).toThrow(StateError)

    expect(history.commitProposal(proposal)).toBe(proposal.entry)
    expect(history.current).toBe(proposal.entry)
    expect(history.proposeFrameReplace(frameScope, "https://example.test/replaced").entry).toEqual({
      restorationIdentifier: "frame",
      restorationIndex: 1,
      url: "https://example.test/replaced",
    })
    expect(ids.calls).toBe(2)
    expect(host.calls.slice(1)).toEqual([
      { entry: proposal.entry, method: "push" },
      { entry: proposal.entry, method: "push" },
    ])
  })

  test("rejects forged and stale Frame proposals without losing the scoped identifier", () => {
    const host = historyHost()
    const history = createHistory(identifiers("initial", "frame", "document"), host)
    const frameScope = {}
    history.initialize({ kind: "unmanaged", url: "https://example.test/current" })
    const stale = history.proposeFrameAdvance(frameScope, "https://example.test/frame/stale")
    const document = history.proposeAdvance("https://example.test/document")

    expect(() =>
      history.commitProposal({ entry: stale.entry, method: stale.method } as never),
    ).toThrow(StateError)
    history.commitProposal(document)
    expect(() => history.commitProposal(stale)).toThrow("Document history proposal is stale")

    const current = history.proposeFrameAdvance(frameScope, "https://example.test/frame/current")
    expect(current.entry.restorationIdentifier).toBe("frame")
    expect(current.entry.restorationIndex).toBe(2)
    history.commitProposal(current)
    expect(history.current).toBe(current.entry)
    expect(host.calls).toHaveLength(3)
  })

  test("rejects invalid Frame scopes and advance overflow before reserving an identifier", () => {
    const ids = identifiers("unused")
    const history = createHistory(ids)
    history.initialize({
      entry: {
        restorationIdentifier: "current",
        restorationIndex: Number.MAX_SAFE_INTEGER,
        url: "https://example.test/current",
      },
      kind: "managed",
    })

    expect(() =>
      history.proposeFrameReplace(null as never, "https://example.test/replaced"),
    ).toThrow("Document Frame history scopes must be objects")
    expect(() => history.proposeFrameAdvance({}, "https://example.test/next")).toThrow(StateError)
    expect(ids.calls).toBe(0)
  })

  test("retargets redirects without changing the requested-location history method", () => {
    const ids = identifiers("initial", "advance", "same-location")
    const history = createHistory(ids)
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
    const host = historyHost()
    const history = createHistory(identifiers("initial", "first", "second"), host)
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
    expect(host.calls).toHaveLength(2)
  })

  test("blocks every history mutation while the host writer is active", () => {
    const ids = identifiers("initial", "primary", "secondary", "unused")
    let history: DocumentHistory
    let initialEntry: DocumentHistoryEntry
    let secondary: ReturnType<DocumentHistory["proposeAdvance"]>
    let inspectReentrancy = false
    const host = historyHost(() => {
      if (!inspectReentrancy) return
      const mutations = [
        () => history.initialize({ kind: "unmanaged", url: "https://example.test/reentrant" }),
        () =>
          history.adoptTraversal({
            restorationIdentifier: "traversal",
            restorationIndex: 9,
            url: "https://example.test/traversal",
          }),
        () => history.proposeAdvance("https://example.test/reentrant-advance"),
        () => history.proposeReplace("https://example.test/reentrant-replace"),
        () => history.retargetProposal(secondary, "https://example.test/retargeted"),
        () => history.commitProposal(secondary),
        () => history.updateRestorationData("initial", { scrollPosition: { x: 1, y: 2 } }),
      ]

      expect(history.current).toBe(initialEntry)
      expect(history.getRestorationData("initial")).toEqual({})
      for (const mutate of mutations) {
        expect(mutate).toThrow("Document history cannot mutate during another mutation")
      }
    })
    history = createHistory(ids, host)
    initialEntry = history.initialize({
      kind: "unmanaged",
      url: "https://example.test/current",
    }).entry
    const primary = history.proposeAdvance("https://example.test/primary")
    secondary = history.proposeAdvance("https://example.test/secondary")

    inspectReentrancy = true
    expect(history.commitProposal(primary)).toBe(primary.entry)
    expect(history.current).toBe(primary.entry)
    expect(ids.calls).toBe(3)
    expect(host.calls).toHaveLength(2)
    expect(() => history.getRestorationData("secondary")).toThrow(StateError)
  })

  test("rejects push overflow before consuming an identifier", () => {
    const ids = identifiers("replacement")
    const history = createHistory(ids)
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
    const history = createHistory(identifiers("initial", "advance"))
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
      const history = createHistory({ next })
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
    const history = createHistory(identifiers("initial"))
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
    const history = createHistory(identifiers("current"))
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
    const history = createHistory(identifiers("current"))
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
    const history = createHistory(identifiers("first"))
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
    const history = createHistory(identifiers("current"))
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
      const history = createHistory(identifiers("generated"))
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
    const history = createHistory(identifiers("current"))
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
    const history = createHistory(identifiers("  "))

    expect(() =>
      history.initialize({ kind: "unmanaged", url: "https://example.test/current" }),
    ).toThrow(StateError)
    expect(history.current).toBeUndefined()
  })

  test("leaves unmanaged initialization untouched when identifier generation fails", () => {
    const history = createHistory({
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
    const history = createHistory(identifiers("unused"))
    expect(() =>
      history.adoptTraversal({
        restorationIdentifier: "target",
        restorationIndex: 1,
        url: "https://example.test/target",
      }),
    ).toThrow(StateError)
  })
})
