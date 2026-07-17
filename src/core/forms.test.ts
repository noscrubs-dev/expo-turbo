import { describe, expect, test } from "bun:test"

import { PropsError, RegistryError, RequestError, StateError, TargetError } from "./errors"
import { assertActiveFormSubmissionProposal } from "./form-submission-proposal"
import {
  DocumentFormControls,
  type FormControlDescriptor,
  type FormControlRegistration,
  FormControlRegistry,
  type FormControlSelection,
} from "./forms"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"

function formFixture(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      `<Gallery>
      <DemoForm id="form">
        <DemoButton id="save" />
        <DemoInput id="first" />
        <DemoGroup>
          <DemoInput id="second" />
          <DemoInput id="unchecked" />
          <DemoInput id="checked" />
        </DemoGroup>
        <DemoSelect id="multiple" />
        <DemoInput id="disabled" />
        <DemoInput id="unnamed" />
        <DemoInput id="empty-name" />
        <DemoButton id="alternate" />
      </DemoForm>
      <DemoForm id="other-form"><DemoButton id="foreign" /></DemoForm>
      <DemoInput id="outside" />
    </Gallery>`,
      { url: "https://example.test/current" },
    ),
  )
}

function registryFor(session: DocumentSession): FormControlRegistry {
  const form = session.tree.getElementById("form")
  if (!form) throw new Error("form fixture is missing")
  return new FormControlRegistry(session, form.key)
}

describe("native form control registry", () => {
  test("collects successful string controls in XML order and appends the submitter", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const selected = ["one", "", "one"]

    const submitter = registry.register("id:save", { kind: "submitter", name: "commit" })
    registry.register("id:second", { kind: "value", name: "item", value: "two" })
    registry.register("id:checked", { kind: "checkable", checked: true, name: "agree" })
    registry.register("id:first", { kind: "value", name: "item", value: "" })
    registry.register("id:multiple", {
      kind: "multiple",
      name: "choices[]",
      values: selected,
    })
    registry.register("id:unchecked", {
      kind: "checkable",
      checked: false,
      name: "ignored",
      value: "no",
    })
    registry.register("id:disabled", {
      disabled: true,
      kind: "value",
      name: "ignored",
      value: "secret",
    })
    registry.register("id:unnamed", { kind: "value", value: "ignored" })
    registry.register("id:empty-name", { kind: "value", name: "", value: "ignored" })
    registry.register("id:alternate", {
      kind: "submitter",
      name: "other",
      value: "ignored",
    })
    selected.push("late")

    expect(registry.successfulEntries({ submitter: submitter.selection })).toEqual([
      { name: "item", value: "" },
      { name: "item", value: "two" },
      { name: "agree", value: "on" },
      { name: "choices[]", value: "one" },
      { name: "choices[]", value: "" },
      { name: "choices[]", value: "one" },
      { name: "commit", value: "" },
    ])
    expect(registry.successfulEntries()).toEqual([
      { name: "item", value: "" },
      { name: "item", value: "two" },
      { name: "agree", value: "on" },
      { name: "choices[]", value: "one" },
      { name: "choices[]", value: "" },
      { name: "choices[]", value: "one" },
    ])

    const frozen = registry.successfulEntries({ submitter: submitter.selection })
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(frozen.every(Object.isFrozen)).toBe(true)
  })

  test("updates values without changing XML order", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const second = registry.register("id:second", {
      kind: "value",
      name: "item",
      value: "before",
    })
    registry.register("id:first", {
      kind: "value",
      name: "item",
      value: "first",
    })

    second.update({
      checked: true,
      kind: "checkable",
      name: "item",
      value: "after",
    })
    expect(registry.successfulEntries()).toEqual([
      { name: "item", value: "first" },
      { name: "item", value: "after" },
    ])
  })

  test("composes live entries and raw form/submitter attributes into one request plan", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery>
          <DemoForm id="form" action="/form" method="post" enctype="text/plain">
            <DemoInput id="field" />
            <DemoButton
              id="save"
              formaction="/override?preserved=1"
              formmethod="patch"
              formenctype="application/x-www-form-urlencoded"
            />
          </DemoForm>
        </Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    const registry = registryFor(session)
    const field = registry.register("id:field", {
      kind: "value",
      name: "profile[name]",
      value: "Before",
    })
    const submitter = registry.register("id:save", {
      kind: "submitter",
      name: "commit",
      value: "Save",
    })
    const controller = new AbortController()

    field.update({ kind: "value", name: "profile[name]", value: "After" })
    submitter.update({ kind: "submitter", name: "commit", value: "Save now" })
    expect(() => registry.requestPlan({ protocol: { requestId: "form-enctype" } })).toThrow(
      /Text form requests/,
    )
    const plan = registry.requestPlan({
      protocol: {
        capabilityHash: "capability-hash",
        requestId: "request-1",
      },
      signal: controller.signal,
      submitter: submitter.selection,
    })

    expect(plan).toMatchObject({
      effectiveMethod: "PATCH",
      encoding: "application/x-www-form-urlencoded",
      entries: [
        { name: "profile[name]", value: "After" },
        { name: "commit", value: "Save now" },
        { name: "_method", value: "patch" },
      ],
      request: {
        body: {
          contentType: "application/x-www-form-urlencoded;charset=UTF-8",
          value: "profile%5Bname%5D=After&commit=Save+now&_method=patch",
        },
        headers: {
          Accept: "text/vnd.turbo-stream.html, application/vnd.expo-turbo+xml",
          "X-Expo-Turbo-Capabilities": "capability-hash",
          "X-Expo-Turbo-Protocol": "0.1",
          "X-Expo-Turbo-Runtime": "0.1.0",
          "X-Turbo-Request-Id": "request-1",
        },
        method: "POST",
        signal: controller.signal,
        url: "https://example.test/override?preserved=1",
      },
      sourceMethod: "PATCH",
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.entries)).toBe(true)

    session.setAttribute("id:form", "action", "/live-form")
    session.setAttribute("id:form", "method", "delete")
    session.setAttribute("id:form", "enctype", "application/x-www-form-urlencoded")
    session.setAttribute("id:save", "formaction", "")
    session.setAttribute("id:save", "formmethod", "")
    session.setAttribute("id:save", "formenctype", "")
    expect(
      registry.requestPlan({
        protocol: { requestId: "request-live-metadata" },
        submitter: submitter.selection,
      }),
    ).toMatchObject({
      effectiveMethod: "DELETE",
      encoding: "application/x-www-form-urlencoded",
      entries: [
        { name: "profile[name]", value: "After" },
        { name: "commit", value: "Save now" },
        { name: "_method", value: "delete" },
      ],
      request: {
        body: {
          value: "profile%5Bname%5D=After&commit=Save+now&_method=delete",
        },
        method: "POST",
        url: "https://example.test/current",
      },
      sourceMethod: "DELETE",
    })
    expect(() =>
      registry.requestPlan({
        protocol: { requestId: "invalid-signal" },
        signal: false as never,
      }),
    ).toThrow(RequestError)
  })

  test("atomically derives an exact Frame destination and Turbo-Frame request metadata", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery>
          <turbo-frame id="named" />
          <turbo-frame id="outer">
            <turbo-frame id="current" target="named">
              <DemoForm id="form" action="/save" method="post" data-turbo-frame="_top">
                <DemoInput id="field" />
                <DemoButton id="save" data-turbo-frame="_parent" />
              </DemoForm>
            </turbo-frame>
          </turbo-frame>
        </Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    const registry = registryFor(session)
    registry.register("id:field", { kind: "value", name: "value", value: "one" })
    const submitter = registry.register("id:save", {
      kind: "submitter",
      name: "commit",
      value: "Save",
    })

    const proposal = registry.submissionProposal({
      protocol: { requestId: "proposal-parent" },
      submitter: submitter.selection,
    })

    expect(proposal.destination).toEqual({
      frameId: "outer",
      kind: "frame",
      requestedTarget: "_parent",
    })
    expect(proposal.plan.request.headers["Turbo-Frame"]).toBe("outer")
    expect(proposal.plan.entries).toEqual([
      { name: "value", value: "one" },
      { name: "commit", value: "Save" },
    ])
    expect(Object.isFrozen(proposal)).toBe(true)
    expect(Object.isFrozen(proposal.destination)).toBe(true)
    expect(Object.isFrozen(proposal.plan)).toBe(true)
    expect(() => assertActiveFormSubmissionProposal(session, proposal)).not.toThrow()

    session.setAttribute("id:save", "data-turbo-frame", "_top")
    const documentProposal = registry.submissionProposal({
      protocol: { requestId: "proposal-document" },
      submitter: submitter.selection,
    })
    expect(documentProposal.destination).toEqual({
      kind: "document",
      requestedTarget: "_top",
    })
    expect(documentProposal.plan.request.headers).not.toHaveProperty("Turbo-Frame")

    session.setAttribute("id:save", "data-turbo-frame", "")
    const blankSubmitter = registry.submissionProposal({
      protocol: { requestId: "proposal-blank" },
      submitter: submitter.selection,
    })
    expect(blankSubmitter.destination).toEqual({
      frameId: "named",
      kind: "frame",
      requestedTarget: "named",
    })
    expect(blankSubmitter.plan.request.headers["Turbo-Frame"]).toBe("named")

    session.removeAttribute("id:save", "data-turbo-frame")
    session.setAttribute("id:form", "data-turbo-frame", "_self")
    expect(
      registry.submissionProposal({
        protocol: { requestId: "proposal-self" },
        submitter: submitter.selection,
      }).destination,
    ).toEqual({ frameId: "current", kind: "frame", requestedTarget: "_self" })

    expect(() =>
      registry.requestPlan({
        protocol: { frameId: "forged", requestId: "forged-frame" },
      } as never),
    ).toThrow(/derive Turbo-Frame metadata/)

    const getterProtocol = {
      get requestId() {
        Object.defineProperty(this, "frameId", {
          configurable: true,
          enumerable: true,
          value: "forged-by-getter",
        })
        return "getter-frame"
      },
    }
    expect(
      registry.requestPlan({ protocol: getterProtocol as never }).request.headers,
    ).not.toHaveProperty("Turbo-Frame")

    const proxyProtocol = new Proxy(
      { frameId: "forged-by-proxy", requestId: "proxy-frame" },
      { has: () => false },
    )
    expect(
      registry.submissionProposal({ protocol: proxyProtocol as never }).plan.request.headers[
        "Turbo-Frame"
      ],
    ).toBe("current")
  })

  test("captures an enabled named Frame from a document-level form and rejects browser targets", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery>
          <DemoForm id="form" action="/search" data-turbo-frame="named">
            <DemoButton id="save" data-turbo-frame="" />
          </DemoForm>
          <turbo-frame id="named" />
          <turbo-frame id="disabled" disabled="" />
        </Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    const registry = registryFor(session)
    const submitter = registry.register("id:save", { kind: "submitter" })

    const named = registry.submissionProposal({
      protocol: { requestId: "top-named" },
      submitter: submitter.selection,
    })
    expect(named.destination).toEqual({
      frameId: "named",
      kind: "frame",
      requestedTarget: "named",
    })
    expect(named.plan.request.headers["Turbo-Frame"]).toBe("named")

    for (const target of ["disabled", "missing", "_top", "_self", "_parent"]) {
      session.setAttribute("id:form", "data-turbo-frame", target)
      const proposal = registry.submissionProposal({
        protocol: { requestId: `top-${target}` },
      })
      expect(proposal.destination).toEqual({ kind: "document", requestedTarget: target })
      expect(proposal.plan.request.headers).not.toHaveProperty("Turbo-Frame")
    }

    session.setAttribute("id:form", "target", "")
    expect(() =>
      registry.submissionProposal({ protocol: { requestId: "browser-target" } }),
    ).toThrow(/use data-turbo-frame/)
    session.removeAttribute("id:form", "target")
    session.setAttribute("id:save", "formtarget", "")
    expect(() =>
      registry.submissionProposal({
        protocol: { requestId: "browser-formtarget" },
        submitter: submitter.selection,
      }),
    ).toThrow(/use data-turbo-frame/)
  })

  test("retains hidden exact form, submitter, Frame, and tree-generation identity", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery>
          <DemoForm id="form" action="/save" data-turbo-frame="destination">
            <DemoButton id="save" />
          </DemoForm>
          <turbo-frame id="destination" />
        </Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    const registry = registryFor(session)
    const submitter = registry.register("id:save", { kind: "submitter" })
    const proposal = registry.submissionProposal({
      protocol: { requestId: "identity" },
      submitter: submitter.selection,
    })
    expect(() => assertActiveFormSubmissionProposal(session, proposal)).not.toThrow()
    expect(() =>
      assertActiveFormSubmissionProposal(
        session,
        Object.freeze({ destination: proposal.destination, plan: proposal.plan }) as never,
      ),
    ).toThrow(StateError)

    const destination = session.tree.getElementById("destination")
    const replacement = parseExpoTurboDocument('<turbo-frame id="destination" />').getElementById(
      "destination",
    )
    if (!destination || !replacement) throw new Error("destination fixture is missing")
    session.mutate((tree) => tree.replaceNodeWithClones(destination, [replacement]))
    expect(() => assertActiveFormSubmissionProposal(session, proposal)).toThrow(/destination Frame/)

    const replacementProposal = registry.submissionProposal({
      protocol: { requestId: "replacement-destination" },
      submitter: submitter.selection,
    })
    const save = session.tree.getElementById("save")
    const saveReplacement = parseExpoTurboDocument('<DemoButton id="save" />').getElementById(
      "save",
    )
    if (!save || !saveReplacement) throw new Error("submitter fixture is missing")
    session.mutate((tree) => tree.replaceNodeWithClones(save, [saveReplacement]))
    expect(() => assertActiveFormSubmissionProposal(session, replacementProposal)).toThrow(
      /submitter node/,
    )

    const originalTree = session.tree
    session.replaceTree(
      parseExpoTurboDocument('<Gallery><DemoForm id="form" /></Gallery>', {
        url: "https://example.test/replacement",
      }),
    )
    session.replaceTree(originalTree)
    expect(() => assertActiveFormSubmissionProposal(session, replacementProposal)).toThrow(
      /form node/,
    )
  })

  test("snapshots caller inputs once before admitting an exact live proposal", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const form = session.tree.getElementById("form")
    if (!form) throw new Error("form fixture is missing")
    let signalReads = 0
    const controller = new AbortController()

    expect(() =>
      registry.submissionProposal({
        protocol: { requestId: "mutating-signal" },
        get signal() {
          signalReads += 1
          session.mutate((tree) => tree.removeNode(form))
          return controller.signal
        },
      }),
    ).toThrow(StateError)
    expect(signalReads).toBe(1)
  })

  test("reads current form metadata and submitter Stream presence without inventing a fetch", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery>
          <DemoForm id="form" action="/before?stale=1" data-turbo-stream="">
            <DemoInput id="field" />
            <DemoButton id="save" />
          </DemoForm>
        </Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    const registry = registryFor(session)
    registry.register("id:field", { kind: "value", name: "query", value: "live value" })
    const submitter = registry.register("id:save", { kind: "submitter" })
    session.setAttribute("id:form", "action", "/after?discard=1")

    const plan = registry.requestPlan({
      protocol: { requestId: "request-2" },
      submitter: submitter.selection,
    })

    expect(plan.sourceMethod).toBe("GET")
    expect(plan.entries).toEqual([{ name: "query", value: "live value" }])
    expect(plan.request.url).toBe("https://example.test/after?query=live+value")
    expect(plan.request.headers.Accept).toBe(
      "text/vnd.turbo-stream.html, application/vnd.expo-turbo+xml",
    )
    expect(plan.request).not.toHaveProperty("body")

    session.removeAttribute("id:form", "data-turbo-stream")
    expect(
      registry.requestPlan({
        protocol: { requestId: "request-3" },
        submitter: submitter.selection,
      }).request.headers.Accept,
    ).toBe("application/vnd.expo-turbo+xml")
    session.setAttribute("id:save", "data-turbo-stream", "false")
    expect(
      registry.requestPlan({
        protocol: { requestId: "request-4" },
        submitter: submitter.selection,
      }).request.headers.Accept,
    ).toBe("text/vnd.turbo-stream.html, application/vnd.expo-turbo+xml")
  })

  test("rejects planning after exact form replacement or without an active document URL", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const form = session.tree.getElementById("form")
    if (!form) throw new Error("form fixture is missing")
    const replacement = parseExpoTurboDocument('<DemoForm id="form" />').getElementById("form")
    if (!replacement) throw new Error("replacement fixture is missing")
    session.mutate((tree) => tree.replaceNodeWithClones(form, [replacement]))

    expect(() => registry.requestPlan({ protocol: { requestId: "stale-request" } })).toThrow(
      StateError,
    )

    const noUrl = formFixture()
    noUrl.replaceTree(parseExpoTurboDocument('<Gallery><DemoForm id="form" /></Gallery>'))
    const noUrlRegistry = registryFor(noUrl)
    expect(() => noUrlRegistry.requestPlan({ protocol: { requestId: "missing-url" } })).toThrow(
      RequestError,
    )
  })

  test("requires a registration-bound active submitter owned by this registry", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const value = registry.register("id:first", {
      kind: "value",
      name: "field",
      value: "value",
    })
    const save = registry.register("id:save", {
      kind: "submitter",
      name: "commit",
      value: "save",
    })
    const disabled = registry.register("id:alternate", {
      disabled: true,
      kind: "submitter",
      name: "commit",
      value: "disabled",
    })
    const otherRegistry = new FormControlRegistry(session, "id:other-form")
    const foreign = otherRegistry.register("id:foreign", {
      kind: "submitter",
      name: "commit",
      value: "foreign",
    })

    expect(registry.successfulEntries({ submitter: save.selection })).toEqual([
      { name: "field", value: "value" },
      { name: "commit", value: "save" },
    ])
    expect(() => registry.successfulEntries({ submitter: value.selection })).toThrow(TargetError)
    expect(() => registry.successfulEntries({ submitter: disabled.selection })).toThrow(/disabled/)
    expect(() => registry.successfulEntries({ submitter: foreign.selection })).toThrow(TargetError)
    expect(() =>
      registry.successfulEntries({ submitter: { nodeKey: "id:save" } as never }),
    ).toThrow(TargetError)
    expect(() => registry.successfulEntries({ submitter: null as never })).toThrow(TargetError)
    expect(() => registry.successfulEntries({ submitterNodeKey: "id:save" } as never)).toThrow(
      /registration-bound submitter selection/,
    )
    expect(() =>
      registry.requestPlan({
        protocol: { requestId: "legacy-node-key" },
        submitterNodeKey: "id:save",
      } as never),
    ).toThrow(/registration-bound submitter selection/)
  })

  test("rejects a stale submitter selection after same-key replacement", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const save = session.tree.getElementById("save")
    if (!save) throw new Error("submitter fixture is missing")
    const original = registry.register(save.key, {
      kind: "submitter",
      name: "commit",
      value: "old",
    })
    const source = parseExpoTurboDocument(
      '<DemoButton id="save" formaction="/new" formmethod="post" />',
    ).getElementById("save")
    if (!source) throw new Error("replacement submitter fixture is missing")

    session.mutate((tree) => tree.replaceNodeWithClones(save, [source]))

    const replacement = registry.register("id:save", {
      kind: "submitter",
      name: "commit",
      value: "new",
    })
    expect(replacement.nodeKey).toBe(original.nodeKey)
    expect(replacement.selection).not.toBe(original.selection)
    expect(() => registry.successfulEntries({ submitter: original.selection })).toThrow(TargetError)
    expect(
      registry.requestPlan({
        protocol: { requestId: "same-key-replacement" },
        submitter: replacement.selection,
      }),
    ).toMatchObject({
      entries: [{ name: "commit", value: "new" }],
      request: { method: "POST", url: "https://example.test/new" },
      sourceMethod: "POST",
    })
  })

  test("cleans exact control registrations on removal and same-id replacement", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const first = session.tree.getElementById("first")
    if (!first) throw new Error("control fixture is missing")
    const registration = registry.register(first.key, {
      kind: "value",
      name: "field",
      value: "old",
    })

    const source = parseExpoTurboDocument('<DemoInput id="first" />').getElementById("first")
    if (!source) throw new Error("replacement fixture is missing")
    session.mutate((tree) => tree.replaceNodeWithClones(first, [source]))

    expect(() => registration.update({ kind: "value", name: "field", value: "stale" })).toThrow(
      StateError,
    )
    expect(registry.successfulEntries()).toEqual([])
    registry.register("id:first", { kind: "value", name: "field", value: "new" })
    expect(registry.successfulEntries()).toEqual([{ name: "field", value: "new" }])
  })

  test("preserves the registry across child updates and disposes it with the exact form", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const form = session.tree.getElementById("form")
    const first = session.tree.getElementById("first")
    if (!form || !first) throw new Error("form fixture is missing")
    const registration = registry.register(first.key, {
      kind: "value",
      name: "field",
      value: "old",
    })

    const children = parseExpoTurboDocument(
      '<DemoForm id="form"><DemoInput id="replacement" /></DemoForm>',
    ).getElementById("form")
    if (!children) throw new Error("children fixture is missing")
    session.mutate((tree) => tree.replaceChildrenWithClones(form, children.children))
    expect(registry.isDisposed).toBe(false)
    expect(registry.successfulEntries()).toEqual([])
    expect(() => registration.update({ kind: "value", name: "field", value: "stale" })).toThrow(
      StateError,
    )
    registry.register("id:replacement", {
      kind: "value",
      name: "field",
      value: "current",
    })

    const replacement = parseExpoTurboDocument('<DemoForm id="form" />').getElementById("form")
    if (!replacement) throw new Error("form replacement fixture is missing")
    session.mutate((tree) => tree.replaceNodeWithClones(form, [replacement]))
    expect(registry.isDisposed).toBe(true)
    expect(() => registry.successfulEntries()).toThrow(StateError)
    expect(() =>
      registry.register("id:replacement", {
        kind: "value",
        name: "field",
        value: "late",
      }),
    ).toThrow(StateError)
  })

  test("rejects foreign, inactive, duplicate, and malformed registrations", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const first = registry.register("id:first", {
      kind: "value",
      name: "field",
      value: "value",
    })

    expect(() =>
      registry.register("id:first", { kind: "value", name: "again", value: "value" }),
    ).toThrow(RegistryError)
    expect(() =>
      registry.register("id:foreign", { kind: "value", name: "foreign", value: "value" }),
    ).toThrow(TargetError)
    expect(() =>
      registry.register("id:outside", { kind: "value", name: "outside", value: "value" }),
    ).toThrow(TargetError)
    expect(() =>
      registry.register("missing", { kind: "value", name: "missing", value: "value" }),
    ).toThrow(TargetError)
    expect(() =>
      registry.register("id:second", {
        kind: "multiple",
        name: "invalid",
        values: ["safe", 2],
      } as unknown as FormControlDescriptor),
    ).toThrow(PropsError)
    const sparse = new Array<string>(1)
    expect(() =>
      registry.register("id:second", {
        kind: "multiple",
        name: "invalid",
        values: sparse,
      }),
    ).toThrow(PropsError)

    first.unregister()
    first.unregister()
    expect(() => first.update({ kind: "value", name: "field", value: "late" })).toThrow(StateError)
    registry.register("id:first", { kind: "value", name: "again", value: "value" })
    registry.dispose()
    registry.dispose()
    expect(registry.isDisposed).toBe(true)
    expect(() => registry.successfulEntries()).toThrow(StateError)
  })

  test("requires an active element as the form owner", () => {
    const session = formFixture()
    expect(() => new FormControlRegistry(session, "missing")).toThrow(TargetError)
    expect(() => new FormControlRegistry(session, session.tree.document.key)).toThrow(TargetError)
  })
})

describe("document form-control ownership", () => {
  test("retains one registry for the exact form across child updates", () => {
    const session = formFixture()
    const forms = new DocumentFormControls(session)
    const form = session.tree.getElementById("form")
    if (!form) throw new Error("form fixture is missing")
    const registry = forms.controlsFor(form.key)
    registry.register("id:first", { kind: "value", name: "field", value: "before" })

    expect(forms.controlsFor(form.key)).toBe(registry)
    const updated = parseExpoTurboDocument(
      '<DemoForm id="form"><DemoInput id="after" /></DemoForm>',
    ).getElementById("form")
    if (!updated) throw new Error("updated form fixture is missing")
    session.mutate((tree) => tree.replaceChildrenWithClones(form, updated.children))

    expect(forms.controlsFor(form.key)).toBe(registry)
    expect(registry.successfulEntries()).toEqual([])
    registry.register("id:after", { kind: "value", name: "field", value: "after" })
    expect(registry.successfulEntries()).toEqual([{ name: "field", value: "after" }])
  })

  test("rebinds same-key replacement to a fresh registry", () => {
    const session = formFixture()
    const forms = new DocumentFormControls(session)
    const form = session.tree.getElementById("form")
    if (!form) throw new Error("form fixture is missing")
    const original = forms.controlsFor(form.key)
    const replacement = parseExpoTurboDocument(
      '<DemoForm id="form"><DemoInput id="replacement" /></DemoForm>',
    ).getElementById("form")
    if (!replacement) throw new Error("replacement form fixture is missing")

    session.mutate((tree) => tree.replaceNodeWithClones(form, [replacement]))

    expect(original.isDisposed).toBe(true)
    const rebound = forms.controlsFor("id:form")
    expect(rebound).not.toBe(original)
    rebound.register("id:replacement", { kind: "value", name: "field", value: "new" })
    expect(rebound.successfulEntries()).toEqual([{ name: "field", value: "new" }])
  })

  test("disposes every owned registry and rejects later access", () => {
    const session = formFixture()
    const forms = new DocumentFormControls(session)
    const form = forms.controlsFor("id:form")
    const other = forms.controlsFor("id:other-form")

    forms.dispose()
    forms.dispose()

    expect(forms.isDisposed).toBe(true)
    expect(form.isDisposed).toBe(true)
    expect(other.isDisposed).toBe(true)
    expect(() => forms.controlsFor("id:form")).toThrow(StateError)
  })
})

// Compile-time coverage: registration handles do not expose a mutable node key.
function updateRegistration(registration: FormControlRegistration): void {
  // @ts-expect-error Form control registration identity is immutable.
  registration.nodeKey = "other"
  // @ts-expect-error Form control selections cannot be replaced by consumers.
  registration.selection = { nodeKey: "other" }
}
void updateRegistration

// @ts-expect-error Submitter selections are opaque registration-issued handles.
const forgedSelection: FormControlSelection = { nodeKey: "id:save" }
void forgedSelection
