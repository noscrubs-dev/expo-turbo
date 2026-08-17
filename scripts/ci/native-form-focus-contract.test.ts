import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "../..")
const flowPath = join(root, ".maestro/release-gallery-native-form.yaml")
const fixturePath = join(root, "example/expo/src/demo-device-test-scenarios.ts")
const registryPath = join(root, "example/expo/src/demo-registry.tsx")
const probePath = join(root, "example/expo/src/demo-device-test-form-probes.tsx")

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1
}

function invalidSection(flow: string): string {
  const start = flow.indexOf("# The shared oracle is the real React Native TextInput event stream.")
  const end = flow.indexOf("- inputText: Ada", start)
  if (start < 0 || end < 0) throw new Error("invalid focus section markers are missing")
  return flow.slice(start, end)
}

function assertBoundedCommands(section: string): void {
  for (const command of section.split(/(?=^- )/m)) {
    if (
      !command.startsWith("- extendedWaitUntil:") &&
      !command.startsWith("- scrollUntilVisible:")
    ) {
      continue
    }
    const timeout = command.match(/\n\s+timeout: (\d+)/)?.[1]
    if (!timeout || Number(timeout) > 5000) {
      throw new Error("invalid focus waits and scrolls must have a timeout of at most 5 seconds")
    }
  }
}

function assertNativeFormContract({
  fixture,
  flow,
  probes,
  registry,
}: Readonly<{ fixture: string; flow: string; probes: string; registry: string }>): void {
  const formFixture = fixture.slice(
    fixture.indexOf("  form:"),
    fixture.indexOf('  "document-links-primary"'),
  )
  if (/DemoFormInput id="first-name"[^>]*autofocus/.test(formFixture)) {
    throw new Error("the device native-form fixture must not autofocus first name")
  }

  const section = invalidSection(flow)
  if (/pressKey: BACK|hideKeyboard/.test(section)) {
    throw new Error("the invalid focus section must not use BACK or hideKeyboard")
  }
  if (!section.includes("- tapOn:\n    id: demo-form-input-id-first-name")) {
    throw new Error("the flow must explicitly tap first name")
  }
  if (!section.includes('text: "Focus probe: focused; revision 1"')) {
    throw new Error("the flow must observe the initial real focus event before eraseText")
  }
  if (section.indexOf("revision 1") > section.indexOf("- eraseText")) {
    throw new Error("the first focus event must be observed before eraseText")
  }
  if (occurrences(section, "# Invalid submission focus cycle ") !== 9) {
    throw new Error("the flow must contain nine explicit focus cycles")
  }
  if (occurrences(section, "id: demo-form-focus-probe-id-first-name") !== 19) {
    throw new Error("the shared React Native event probe must guard all focus transitions")
  }
  assertBoundedCommands(section)

  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const marker = `# Invalid submission focus cycle ${attempt} of 9.`
    const nextMarker = `# Invalid submission focus cycle ${attempt + 1} of 9.`
    const start = section.indexOf(marker)
    const end = attempt === 9 ? section.length : section.indexOf(nextMarker, start)
    if (start < 0 || end < 0) throw new Error(`focus cycle ${attempt} is missing`)
    const cycle = section.slice(start, end)
    const ordered = [
      "text: Live native form controls",
      `text: "Focus probe: blurred; revision ${attempt * 2}"`,
      "focused: false",
      "visible: Form ready",
      "assertNotVisible: Confirm form submission",
      "id: demo-form-submitter-id-collect-form",
      `text: "Submit proof: invalid; attempt ${attempt}"`,
      `text: "Focus probe: focused; revision ${attempt * 2 + 1}"`,
      "focused: true",
      "assertVisible: First name is required",
    ]
    let offset = -1
    for (const proof of ordered) {
      const next = cycle.indexOf(proof, offset + 1)
      if (next < 0) throw new Error(`focus cycle ${attempt} is missing ${proof}`)
      offset = next
    }
    if (occurrences(cycle, `Submit proof: invalid; attempt ${attempt}`) !== 1) {
      throw new Error(`focus cycle ${attempt} must use one distinct submit proof`)
    }
    if (occurrences(cycle, "platform: Android") !== 2) {
      throw new Error(`cycle ${attempt} must guard both native focused selectors as Android-only`)
    }
    if (occurrences(cycle, "assertNotVisible: Submission loading state observed") < 2) {
      throw new Error(`cycle ${attempt} must exclude loading before and after invalid submit`)
    }
  }

  const sharedWait =
    "- extendedWaitUntil:\n    visible:\n      id: demo-form-focus-probe-id-first-name"
  if (occurrences(section, sharedWait) !== 19 || section.includes("platform: iOS")) {
    throw new Error("the React Native focus event oracle must remain shared with iOS")
  }
  if (occurrences(section, "focused: false") !== 9 || occurrences(section, "focused: true") !== 9) {
    throw new Error("native focus selectors must be additional Android checks for each cycle")
  }

  if (
    !registry.includes(
      "onBlur={() => {\n                autofocusScroll.onBlur();\n                focusHandlers.onBlur();\n                focusProbe.onActualBlur();",
    )
  ) {
    throw new Error("the focus probe must be updated by the actual TextInput onBlur callback")
  }
  if (
    !registry.includes(
      "onFocus={() => {\n                focusHandlers.onFocus();\n                autofocusScroll.onFocus();\n                focusProbe.onActualFocus();",
    )
  ) {
    throw new Error("the focus probe must be updated by the actual TextInput onFocus callback")
  }
  if (probes.includes("DemoFocusRegistry") || probes.includes("getFocusedId")) {
    throw new Error("the focus probe must not read the logical focus ledger")
  }
  if (!registry.includes("submitProof.observe(submission)")) {
    throw new Error("submit proof must observe the actual form submission promise")
  }
}

describe("native form focus device contract", () => {
  test("keeps the fixture, React probes, and nine-cycle shared flow evidence-backed", async () => {
    const [fixture, flow, probes, registry] = await Promise.all([
      readFile(fixturePath, "utf8"),
      readFile(flowPath, "utf8"),
      readFile(probePath, "utf8"),
      readFile(registryPath, "utf8"),
    ])
    const sources = { fixture, flow, probes, registry }

    expect(() => assertNativeFormContract(sources)).not.toThrow()
    expect(() =>
      assertNativeFormContract({
        ...sources,
        flow: flow.replace('text: "Focus probe: blurred; revision 2"', "text: blur removed"),
      }),
    ).toThrow(/missing text: "Focus probe: blurred/)
    expect(() =>
      assertNativeFormContract({
        ...sources,
        flow: flow.replace(
          'text: "Submit proof: invalid; attempt 1"',
          "text: First name is required",
        ),
      }),
    ).toThrow(/missing text: "Submit proof: invalid; attempt 1"/)
    expect(() =>
      assertNativeFormContract({
        ...sources,
        flow: flow.replace(
          'text: "Submit proof: invalid; attempt 9"',
          'text: "Submit proof: invalid; attempt 8"',
        ),
      }),
    ).toThrow(/attempt 9/)
    expect(() =>
      assertNativeFormContract({
        ...sources,
        registry: registry.replace("focusProbe.onActualFocus();", "focusHandlers.onFocus();"),
      }),
    ).toThrow(/actual TextInput onFocus/)
    expect(() =>
      assertNativeFormContract({
        ...sources,
        flow: flow.replace(
          "- extendedWaitUntil:\n    visible:\n      id: demo-form-focus-probe-id-first-name",
          "- runFlow:\n    when:\n      platform: Android\n    commands:\n      - extendedWaitUntil:\n          visible:\n            id: demo-form-focus-probe-id-first-name",
        ),
      }),
    ).toThrow(/shared with iOS/)
  })
})
