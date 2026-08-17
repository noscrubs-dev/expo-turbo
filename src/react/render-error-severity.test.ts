import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

/**
 * Issue #435 turns on a claim that has to stay true as the renderer grows: every
 * failure a host is told about states what it cost. A severity that covers some
 * delivery points and not others is worse than none, because the ones it misses
 * look like a deliberate omission.
 *
 * The enumeration method, so it is repeatable by hand: an `ExpoTurboRenderError`
 * reaches a host only by calling the event callback with an object literal.
 * There is no other constructor for it and the type is not exported as a value.
 * So every delivery point in the renderer matches one of the three call shapes
 * below — the callback under its own name, under `props`, or through the local
 * alias the deferred reporters take — and each match must carry an explicit
 * `severity`.
 *
 *     grep -nE '(onError\?\.\(\{|onError\(\{|observer\(\{)' src/react/renderer.ts
 *
 * The count is pinned as well as the shape: a new delivery point that carries a
 * severity is a deliberate change and updates this number; one that arrives
 * without a severity fails the assertion above it.
 */
const DELIVERY_CALL = /(?:\bonError\?\.\(\{|\bonError\(\{|\bobserver\(\{)/g
const DELIVERY_POINTS = 16
const SEVERITIES = ["background", "document", "speculative"] as const

async function rendererSource(): Promise<string> {
  return readFile(new URL("./renderer.ts", import.meta.url), "utf8")
}

/** The literal argument of one delivery call, from `({` to its matching `})`. */
function callArgument(source: string, start: number): string {
  let depth = 0
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    const character = source[index]
    if (character === "{") depth += 1
    else if (character === "}") {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unterminated render error event at offset ${start}`)
}

describe("render error severity", () => {
  test("every renderer delivery point states what the failure cost", async () => {
    const source = await rendererSource()
    const missing: string[] = []
    let found = 0
    for (const match of source.matchAll(DELIVERY_CALL)) {
      found += 1
      const argument = callArgument(source, match.index)
      const severity = /\bseverity:\s*"([a-z]+)"/.exec(argument)?.[1]
      if (!severity || !SEVERITIES.includes(severity as (typeof SEVERITIES)[number])) {
        missing.push(`${source.slice(0, match.index).split("\n").length}: ${argument}`)
      }
    }

    // A regression here means a host boundary is guessing again for that path.
    expect(missing).toEqual([])
    // And the pattern really matched something, so an empty `missing` cannot
    // mean the search itself stopped working.
    expect(found).toBe(DELIVERY_POINTS)
  })

  test("the taxonomy covers each delivery point exactly once", async () => {
    const source = await rendererSource()
    const counts = { background: 0, document: 0, speculative: 0 }
    for (const match of source.matchAll(DELIVERY_CALL)) {
      const severity = /\bseverity:\s*"([a-z]+)"/.exec(callArgument(source, match.index))?.[1]
      if (severity && severity in counts) counts[severity as keyof typeof counts] += 1
    }

    // Two announcement adapters, five focus and scroll adapters, and retained
    // morph focus: eight accessories to a render that already succeeded.
    expect(counts.background).toBe(8)
    // Two automatic preloads, one automatic preload policy, one press-in
    // prefetch, one press-in prefetch policy: five discardable requests.
    expect(counts.speculative).toBe(5)
    // The node error boundary, the Frame controller, and the document visit
    // controller.
    expect(counts.document).toBe(3)
    expect(counts.background + counts.speculative + counts.document).toBe(DELIVERY_POINTS)
  })
})
