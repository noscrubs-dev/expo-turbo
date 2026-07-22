import { describe, expect, test } from "bun:test"

import { isTurboMultipartBody } from "../adapters"
import { PropsError, RegistryError, RequestError, StateError, TargetError } from "./errors"
import { FormSubmissionController } from "./form-submission-controller"
import { assertActiveFormSubmissionProposal } from "./form-submission-proposal"
import {
  DocumentFormControls,
  type FormControlDescriptor,
  type FormControlDirectionality,
  type FormControlRegistration,
  FormControlRegistry,
  type FormControlRegistryOptions,
  type FormControlSelection,
  type FormSelectItem,
  type FormSelectOption,
  MAX_FORM_CONTROL_ENTRIES_PER_CONTROL,
  type SuccessfulFormEntry,
} from "./forms"
import { parseExpoTurboDocument } from "./parser"
import { EXPO_TURBO_MIME_TYPE, TURBO_STREAM_MIME_TYPE } from "./protocol-request"
import { RequestLifecycle } from "./request-lifecycle"
import { DocumentSession } from "./session"
import { isElement } from "./tree"

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

function externalFormFixture(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      `<Gallery>
        <DemoInput id="before" form="form" />
        <DemoButton id="external-submit" form="form" />
        <DemoForm id="form" action="/save" method="post">
          <DemoInput id="inside" />
          <DemoInput id="override" form="other-form" />
        </DemoForm>
        <DemoInput id="after" form="form" />
        <DemoForm id="other-form">
          <DemoInput id="other-inside" />
        </DemoForm>
        <DemoInput id="missing-owner" form="missing" />
        <DemoInput id="blank-owner" form="" />
        <DemoInput id="outside" />
      </Gallery>`,
      { url: "https://example.test/current" },
    ),
  )
}

function formModeFixture(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      `<Gallery id="root">
        <Gallery id="form-outer">
          <Gallery id="form-inner">
            <DemoForm id="form">
              <Gallery id="submitter-outer"><DemoButton id="save" /></Gallery>
            </DemoForm>
          </Gallery>
        </Gallery>
        <Gallery id="external-outer"><DemoButton id="external-submit" form="form" /></Gallery>
        <DemoForm id="other-form"><DemoButton id="foreign" /></DemoForm>
      </Gallery>`,
      { url: "https://example.test/current" },
    ),
  )
}

function fieldsetFixture(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      `<Gallery>
        <DemoFieldset id="external-fieldset" disabled="">
          <DemoLegend id="external-legend">
            <DemoButton id="external-submit" form="form" />
          </DemoLegend>
          <DemoInput id="external-disabled" form="form" />
        </DemoFieldset>
        <DemoInput id="external-enabled" form="form" />
        <DemoFieldset id="owner-only-fieldset" form="form">
          <DemoInput id="not-associated" />
        </DemoFieldset>
        <DemoForm id="form">
          <DemoFieldset id="outer-fieldset" disabled="false">
            <DemoGroup id="wrapped-legend">
              <DemoLegend id="nested-legend">
                <DemoInput id="nested-legend-value" />
              </DemoLegend>
            </DemoGroup>
            <DemoLegend id="outer-first-legend">
              <DemoInput id="outer-exempt" />
              <DemoInput id="direct-disabled" />
              <DemoFieldset id="inner-fieldset" disabled="">
                <DemoLegend id="inner-first-legend">
                  <DemoInput id="inner-exempt" />
                </DemoLegend>
                <DemoInput id="inner-disabled" />
              </DemoFieldset>
            </DemoLegend>
            <DemoLegend id="outer-second-legend">
              <DemoInput id="second-legend-value" />
            </DemoLegend>
            <DemoInput id="outer-body" />
          </DemoFieldset>
          <DemoFieldset id="live-fieldset">
            <DemoInput id="live-value" />
            <DemoButton id="live-submit" />
          </DemoFieldset>
        </DemoForm>
      </Gallery>`,
      { url: "https://example.test/current" },
    ),
  )
}

function datalistFixture(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      `<Gallery>
        <DemoDatalist id="external-list">
          <DemoGroup><DemoInput id="external-barred" form="form" /></DemoGroup>
          <DemoButton id="external-submit" form="form" />
        </DemoDatalist>
        <DemoInput id="external-enabled" form="form" />
        <DemoForm id="form" action="/submit" method="post">
          <DemoInput id="before" />
          <DemoDatalist id="list">
            <DemoInput id="value" />
            <DemoInput id="checkable" />
            <DemoSelect id="select" />
            <DemoInput id="hidden" />
            <DemoGroup>
              <DemoDatalist id="nested-list">
                <DemoInput id="directional" />
              </DemoDatalist>
            </DemoGroup>
          </DemoDatalist>
          <DemoFieldset id="fieldset" disabled="">
            <DemoLegend><DemoInput id="fieldset-exempt" /></DemoLegend>
          </DemoFieldset>
          <DemoInput id="after" />
        </DemoForm>
      </Gallery>`,
      { url: "https://example.test/current" },
    ),
  )
}

const FORM_SEMANTICS = Object.freeze({
  formContainerRole: (element: { readonly tagName: string }) => {
    if (element.tagName === "DemoDatalist") return "datalist" as const
    if (element.tagName === "DemoFieldset") return "fieldset" as const
    if (element.tagName === "DemoLegend") return "legend" as const
    return undefined
  },
})

function registryFor(
  session: DocumentSession,
  options: FormControlRegistryOptions = {},
): FormControlRegistry {
  const form = session.tree.getElementById("form")
  if (!form) throw new Error("form fixture is missing")
  return new FormControlRegistry(session, form.key, options)
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
      entries: [{ name: "ignored", value: "secret" }],
      kind: "entries",
      validity: { message: "Disabled entry list is invalid", valid: false },
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
    expect(registry.checkValidity()).toEqual({ invalidControls: [], valid: true })
  })

  test("collects frozen bounded multi-name string entries at the control's document position", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const source = [
      { name: "profile[given_name]", value: "Ada" },
      { name: "profile[roles][]", value: "author" },
      { name: "profile[roles][]", value: "" },
      { name: "", value: "empty-name" },
      { name: "_charset_", value: "host-owned" },
    ]
    const entryList = registry.register("id:first", {
      entries: source,
      kind: "entries",
      validity: { valid: true },
    })
    const submitter = registry.register("id:save", {
      kind: "submitter",
      name: "commit",
      value: "save",
    })
    registry.register("id:second", { kind: "value", name: "after", value: "B" })

    const firstSourceEntry = source[0]
    if (!firstSourceEntry) throw new Error("entry-list fixture is missing")
    firstSourceEntry.value = "mutated"
    source.push({ name: "late", value: "ignored" })

    const collected = registry.successfulEntries({ submitter: submitter.selection })
    expect(collected).toEqual([
      { name: "profile[given_name]", value: "Ada" },
      { name: "profile[roles][]", value: "author" },
      { name: "profile[roles][]", value: "" },
      { name: "", value: "empty-name" },
      { name: "_charset_", value: "host-owned" },
      { name: "after", value: "B" },
      { name: "commit", value: "save" },
    ])
    expect(Object.isFrozen(collected)).toBe(true)
    expect(collected.every(Object.isFrozen)).toBe(true)
    const planned = registry.requestPlan({
      protocol: { requestId: "entry-list" },
      submitter: submitter.selection,
    })
    expect(planned.entries).toEqual(collected)
    expect(Array.from(new URL(planned.request.url).searchParams.entries())).toEqual(
      collected.map(({ name, value }) => {
        if (typeof value !== "string") throw new Error("entry-list fixture must remain string-only")
        return [name, value]
      }),
    )

    const updated = [{ name: "replacement[first]", value: "one" }]
    entryList.update({
      entries: updated,
      kind: "entries",
      validity: { message: "Choose another value", valid: false },
    })
    const firstUpdatedEntry = updated[0]
    if (!firstUpdatedEntry) throw new Error("updated entry-list fixture is missing")
    firstUpdatedEntry.value = "mutated"
    expect(registry.successfulEntries()).toEqual([
      { name: "replacement[first]", value: "one" },
      { name: "after", value: "B" },
    ])
    expect(registry.checkValidity()).toMatchObject({
      firstInvalid: { message: "Choose another value", nodeKey: "id:first" },
      valid: false,
    })
  })

  test("collects a host-owned Blob entry only into a multipart request plan", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery><DemoForm id="form" action="/upload" enctype="multipart/form-data" method="post"><DemoInput id="attachment" /><DemoButton id="submit" /></DemoForm></Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    const registry = registryFor(session)
    const attachment = {
      blob: new Blob(["native fixture"], { type: "text/plain" }),
      filename: "native-fixture.txt",
    }
    const source: SuccessfulFormEntry[] = [{ name: "profile[attachment]", value: attachment }]
    registry.register("id:attachment", { entries: source, kind: "entries" })
    const submitter = registry.register("id:submit", {
      kind: "submitter",
      name: "commit",
      value: "upload",
    })

    source.push({ name: "late", value: "ignored" })
    const entries = registry.successfulEntries({ submitter: submitter.selection })
    expect(entries).toEqual([
      { name: "profile[attachment]", value: attachment },
      { name: "commit", value: "upload" },
    ])
    const planned = registry.requestPlan({
      protocol: { requestId: "multipart-entry-list" },
      submitter: submitter.selection,
    })
    const body = planned.request.body?.value
    if (!isTurboMultipartBody(body)) throw new Error("multipart request was not planned")
    expect(body.entries).toEqual(entries)
    expect(Object.isFrozen(body.entries[0]?.value)).toBe(true)
  })

  test("bounds one multi-name entry-list snapshot and keeps the previous value after rejection", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const admitted = Array.from({ length: MAX_FORM_CONTROL_ENTRIES_PER_CONTROL }, (_, index) => ({
      name: `field[${index}]`,
      value: `${index}`,
    }))
    const entryList = registry.register("id:first", {
      entries: admitted,
      kind: "entries",
    })
    expect(registry.successfulEntries()).toHaveLength(MAX_FORM_CONTROL_ENTRIES_PER_CONTROL)

    expect(() =>
      entryList.update({
        entries: [
          ...admitted,
          {
            name: "overflow",
            value: "rejected",
          },
        ],
        kind: "entries",
      }),
    ).toThrow(PropsError)
    expect(registry.successfulEntries()).toHaveLength(MAX_FORM_CONTROL_ENTRIES_PER_CONTROL)
    expect(registry.successfulEntries().at(-1)).toEqual({
      name: `field[${MAX_FORM_CONTROL_ENTRIES_PER_CONTROL - 1}]`,
      value: `${MAX_FORM_CONTROL_ENTRIES_PER_CONTROL - 1}`,
    })
  })

  test("uses the captured array length instead of a caller-supplied entry iterator", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const entries = [{ name: "field", value: "admitted" }]
    const firstEntry = entries[0]
    if (!firstEntry) throw new Error("custom-iterator fixture is missing")
    Object.defineProperty(entries, Symbol.iterator, {
      value: function* customEntries() {
        yield firstEntry
        for (let index = 0; index < MAX_FORM_CONTROL_ENTRIES_PER_CONTROL; index += 1) {
          yield { name: `overflow[${index}]`, value: `${index}` }
        }
      },
    })

    registry.register("id:first", { entries, kind: "entries" })

    expect(registry.successfulEntries()).toEqual([{ name: "field", value: "admitted" }])
  })

  test("reads each entry name and value once before freezing the snapshot", () => {
    const session = formFixture()
    const registry = registryFor(session)
    let nameReads = 0
    let valueReads = 0
    const entry = {
      get name(): unknown {
        nameReads += 1
        return nameReads === 1 ? "field" : { uri: "file:///name" }
      },
      get value(): unknown {
        valueReads += 1
        return valueReads === 1 ? "admitted" : { uri: "file:///value" }
      },
    }

    registry.register("id:first", {
      entries: [entry] as unknown as readonly { readonly name: string; readonly value: string }[],
      kind: "entries",
    })

    expect(registry.successfulEntries()).toEqual([{ name: "field", value: "admitted" }])
    expect({ nameReads, valueReads }).toEqual({ nameReads: 1, valueReads: 1 })
  })

  test("snapshots descriptor kind and disabledness once before normalization", () => {
    const session = formFixture()
    const registry = registryFor(session)
    let kindReads = 0
    let disabledReads = 0
    const disabledValues: readonly unknown[] = [false, false, false, { secret: "not-boolean" }]
    const descriptor = {
      get disabled(): unknown {
        const value = disabledValues[Math.min(disabledReads, disabledValues.length - 1)]
        disabledReads += 1
        return value
      },
      entries: [{ name: "field", value: "admitted" }],
      get kind(): unknown {
        kindReads += 1
        return kindReads === 1 ? "entries" : "value"
      },
    }

    registry.register("id:first", descriptor as unknown as FormControlDescriptor)

    expect(registry.successfulEntries()).toEqual([{ name: "field", value: "admitted" }])
    expect({ disabledReads, kindReads }).toEqual({ disabledReads: 1, kindReads: 1 })
  })

  test("reads entry-list validity fields once before freezing the snapshot", () => {
    const session = formFixture()
    const registry = registryFor(session)
    let messageReads = 0
    let validReads = 0
    const validity = {
      get message(): unknown {
        messageReads += 1
        return messageReads === 1 ? "Choose another value" : { secret: "not-string" }
      },
      get valid(): unknown {
        validReads += 1
        return false
      },
    }

    registry.register("id:first", {
      entries: [{ name: "field", value: "admitted" }],
      kind: "entries",
      validity: validity as unknown as { readonly message: string; readonly valid: false },
    })

    expect(registry.checkValidity()).toMatchObject({
      firstInvalid: { message: "Choose another value", nodeKey: "id:first" },
      valid: false,
    })
    expect({ messageReads, validReads }).toEqual({ messageReads: 1, validReads: 1 })
  })

  test("matches Turbo's manual submitter append without browser image or dirname sidecars", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const named = registry.register("id:save", {
      kind: "submitter",
      name: "commit",
      value: "save",
    })
    const defaultValue = registry.register("id:alternate", {
      kind: "submitter",
      name: "default_commit",
    })
    const unnamed = registry.register("id:checked", {
      kind: "submitter",
      value: "ignored",
    })

    const namedEntries = registry.successfulEntries({ submitter: named.selection })
    expect(namedEntries).toEqual([{ name: "commit", value: "save" }])
    expect(registry.successfulEntries({ submitter: defaultValue.selection })).toEqual([
      { name: "default_commit", value: "" },
    ])
    expect(registry.successfulEntries({ submitter: unnamed.selection })).toEqual([])
    expect(
      namedEntries.some(
        ({ name }) => name === "commit.x" || name === "commit.y" || name === "commit.dir",
      ),
    ).toBe(false)
  })

  test("collects explicitly associated controls in document order and lets them override ancestry", () => {
    const session = externalFormFixture()
    const registry = registryFor(session)
    const otherRegistry = new FormControlRegistry(session, "id:other-form")

    registry.register("id:after", { kind: "value", name: "after", value: "C" })
    registry.register("id:inside", { kind: "value", name: "inside", value: "B" })
    const submitter = registry.register("id:external-submit", {
      kind: "submitter",
      name: "commit",
      value: "external",
    })
    registry.register("id:before", {
      entries: [
        { name: "before", value: "A" },
        { name: "", value: "external-empty" },
      ],
      kind: "entries",
    })
    otherRegistry.register("id:other-inside", {
      kind: "value",
      name: "other",
      value: "E",
    })
    otherRegistry.register("id:override", {
      kind: "value",
      name: "override",
      value: "D",
    })

    expect(registry.successfulEntries({ submitter: submitter.selection })).toEqual([
      { name: "before", value: "A" },
      { name: "", value: "external-empty" },
      { name: "inside", value: "B" },
      { name: "after", value: "C" },
      { name: "commit", value: "external" },
    ])
    expect(otherRegistry.successfulEntries()).toEqual([
      { name: "override", value: "D" },
      { name: "other", value: "E" },
    ])
    expect(() =>
      registry.register("id:override", { kind: "value", name: "wrong", value: "wrong" }),
    ).toThrow(/another form/)
    expect(() =>
      registry.register("id:missing-owner", {
        kind: "value",
        name: "missing",
        value: "missing",
      }),
    ).toThrow(/missing form owner/)
    expect(() =>
      registry.register("id:blank-owner", {
        kind: "value",
        name: "blank",
        value: "blank",
      }),
    ).toThrow(/blank form owner/)
    expect(() =>
      registry.register("id:outside", { kind: "value", name: "outside", value: "outside" }),
    ).toThrow(/another form/)
  })

  test("matches Turbo form modes across independent form and submitter ancestry", () => {
    const session = formModeFixture()
    const on = new FormControlRegistry(session, "id:form")
    const save = on.register("id:save", { kind: "submitter", name: "commit", value: "save" })
    const external = on.register("id:external-submit", {
      kind: "submitter",
      name: "commit",
      value: "external",
    })

    expect(on.shouldInterceptSubmission()).toBe(true)
    expect(on.shouldInterceptSubmission({ submitter: save.selection })).toBe(true)
    session.setAttribute("id:form-inner", "data-turbo", "false")
    expect(on.shouldInterceptSubmission()).toBe(false)
    expect(on.shouldInterceptSubmission({ submitter: save.selection })).toBe(false)
    session.setAttribute("id:form", "data-turbo", "true")
    expect(on.shouldInterceptSubmission()).toBe(true)
    expect(on.shouldInterceptSubmission({ submitter: save.selection })).toBe(true)
    session.setAttribute("id:save", "data-turbo", "false")
    expect(on.shouldInterceptSubmission({ submitter: save.selection })).toBe(false)
    session.setAttribute("id:save", "data-turbo", "FALSE")
    expect(on.shouldInterceptSubmission({ submitter: save.selection })).toBe(true)
    session.setAttribute("id:external-outer", "data-turbo", "false")
    expect(on.shouldInterceptSubmission({ submitter: external.selection })).toBe(false)
    session.setAttribute("id:external-submit", "data-turbo", "true")
    expect(on.shouldInterceptSubmission({ submitter: external.selection })).toBe(true)

    session.removeAttribute("id:form", "data-turbo")
    session.removeAttribute("id:form-inner", "data-turbo")
    session.removeAttribute("id:save", "data-turbo")
    session.removeAttribute("id:external-submit", "data-turbo")
    session.removeAttribute("id:external-outer", "data-turbo")
    const optin = new FormControlRegistry(session, "id:form", { formMode: "optin" })
    const optinSave = optin.register("id:save", {
      kind: "submitter",
      name: "commit",
      value: "save",
    })
    const optinExternal = optin.register("id:external-submit", {
      kind: "submitter",
      name: "commit",
      value: "external",
    })

    expect(optin.shouldInterceptSubmission()).toBe(false)
    session.setAttribute("id:external-submit", "data-turbo", "true")
    expect(optin.shouldInterceptSubmission({ submitter: optinExternal.selection })).toBe(false)
    session.setAttribute("id:form-outer", "data-turbo", "true")
    session.setAttribute("id:form-inner", "data-turbo", "false")
    expect(optin.shouldInterceptSubmission()).toBe(true)
    expect(optin.shouldInterceptSubmission({ submitter: optinSave.selection })).toBe(false)
    session.setAttribute("id:save", "data-turbo", "true")
    expect(optin.shouldInterceptSubmission({ submitter: optinSave.selection })).toBe(true)
    expect(optin.shouldInterceptSubmission({ submitter: optinExternal.selection })).toBe(true)
    session.setAttribute("id:external-submit", "data-turbo", "false")
    expect(optin.shouldInterceptSubmission({ submitter: optinExternal.selection })).toBe(false)
  })

  test("keeps form mode off as an interaction short-circuit and rejects invalid modes", () => {
    const session = formModeFixture()
    const off = new FormControlRegistry(session, "id:form", { formMode: "off" })
    const initialState = off.submissionState
    const initialTerminalState = off.submissionTerminalState

    expect(off.shouldInterceptSubmission()).toBe(false)
    expect(off.shouldInterceptSubmission({ submitter: { nodeKey: "missing" } as never })).toBe(
      false,
    )
    expect(off.submissionState).toBe(initialState)
    expect(off.submissionTerminalState).toBe(initialTerminalState)
    expect(
      () => new FormControlRegistry(session, "id:form", { formMode: "invalid" as never }),
    ).toThrow(PropsError)
    const invalidDocumentControls = new DocumentFormControls(session, {
      formMode: "invalid" as never,
    })
    expect(() => invalidDocumentControls.controlsFor("id:form")).toThrow(PropsError)
  })

  test("reports host-owned constraint snapshots in whole-document order and focuses only first invalid", () => {
    const session = externalFormFixture()
    const focused: string[] = []
    const registry = registryFor(session, {
      focus: {
        blur() {},
        focus: (nodeKey) => {
          focused.push(nodeKey)
        },
        getFocusedId: () => focused.at(-1),
      },
    })
    const before = registry.register("id:before", {
      kind: "value",
      value: "",
      validity: { message: "Before is required", valid: false },
    })
    registry.register("id:inside", {
      kind: "value",
      name: "inside",
      value: "",
      validity: { message: "Inside is required", valid: false },
    })
    registry.register("id:after", {
      kind: "value",
      name: "after",
      value: "",
      validity: { message: "After is required", valid: false },
    })

    const checked = registry.checkValidity()
    expect(checked).toEqual({
      firstInvalid: { message: "Before is required", nodeKey: "id:before" },
      invalidControls: [
        { message: "Before is required", nodeKey: "id:before" },
        { message: "Inside is required", nodeKey: "id:inside" },
        { message: "After is required", nodeKey: "id:after" },
      ],
      valid: false,
    })
    expect(focused).toEqual([])
    expect(Object.isFrozen(checked)).toBe(true)
    expect(Object.isFrozen(checked.invalidControls)).toBe(true)
    expect(checked.invalidControls.every(Object.isFrozen)).toBe(true)

    expect(registry.reportValidity()).toEqual(checked)
    expect(focused).toEqual(["id:before"])

    before.update({ kind: "value", value: "Ada", validity: { valid: true } })
    expect(registry.reportValidity()).toMatchObject({
      firstInvalid: { nodeKey: "id:inside" },
      valid: false,
    })
    expect(focused).toEqual(["id:before", "id:inside"])
  })

  test("admits live validity snapshots for every validatable descriptor family", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const value = registry.register("id:first", {
      kind: "value",
      value: "",
      validity: { message: "Value is invalid", valid: false },
    })
    const checkable = registry.register("id:second", {
      checked: false,
      kind: "checkable",
      validity: { message: "Checkable is invalid", valid: false },
    })
    const multiple = registry.register("id:checked", {
      kind: "multiple",
      values: [],
      validity: { message: "Multiple is invalid", valid: false },
    })
    const select = registry.register("id:multiple", {
      kind: "select",
      options: [{ kind: "option", selected: false, value: "one" }],
      validity: { message: "Select is invalid", valid: false },
    })

    expect(registry.checkValidity()).toMatchObject({
      invalidControls: [
        { nodeKey: "id:first" },
        { nodeKey: "id:second" },
        { nodeKey: "id:checked" },
        { nodeKey: "id:multiple" },
      ],
      valid: false,
    })

    value.update({ kind: "value", value: "Ada", validity: { valid: true } })
    checkable.update({ checked: true, kind: "checkable", validity: { valid: true } })
    multiple.update({ kind: "multiple", values: ["one"], validity: { valid: true } })
    select.update({
      kind: "select",
      options: [{ kind: "option", selected: true, value: "one" }],
      validity: { valid: true },
    })
    expect(registry.checkValidity()).toEqual({ invalidControls: [], valid: true })
  })

  test("bars disabled, fieldset, datalist, hidden, and submitter controls from validation", () => {
    const fieldsetSession = fieldsetFixture()
    const fieldsetRegistry = registryFor(fieldsetSession, { formSemantics: FORM_SEMANTICS })
    for (const nodeKey of [
      "id:external-disabled",
      "id:external-enabled",
      "id:outer-exempt",
      "id:inner-exempt",
      "id:inner-disabled",
      "id:outer-body",
    ]) {
      fieldsetRegistry.register(nodeKey, {
        kind: "value",
        value: "",
        validity: { message: `${nodeKey} invalid`, valid: false },
      })
    }
    expect(fieldsetRegistry.checkValidity()).toMatchObject({
      invalidControls: [
        { nodeKey: "id:external-enabled" },
        { nodeKey: "id:outer-exempt" },
        { nodeKey: "id:inner-exempt" },
      ],
      valid: false,
    })

    const datalistSession = datalistFixture()
    const datalistRegistry = registryFor(datalistSession, { formSemantics: FORM_SEMANTICS })
    datalistRegistry.register("id:external-barred", {
      kind: "value",
      value: "",
      validity: { message: "External barred", valid: false },
    })
    datalistRegistry.register("id:before", {
      kind: "value",
      value: "",
      validity: { message: "Before", valid: false },
    })
    datalistRegistry.register("id:value", {
      kind: "value",
      value: "",
      validity: { message: "Datalist value", valid: false },
    })
    datalistRegistry.register("id:hidden", { kind: "hidden", value: "" })
    datalistRegistry.register("id:external-submit", { kind: "submitter" })
    datalistRegistry.register("id:after", {
      disabled: true,
      kind: "value",
      value: "",
      validity: { message: "Disabled after", valid: false },
    })
    expect(datalistRegistry.checkValidity()).toEqual({
      firstInvalid: { message: "Before", nodeKey: "id:before" },
      invalidControls: [{ message: "Before", nodeKey: "id:before" }],
      valid: false,
    })
  })

  test("blocks interactive submission before confirmation, activity, terminal state, and fetch", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery><DemoForm id="form" action="/submit" method="post" data-turbo-confirm="Confirm">
          <DemoInput id="field" />
          <DemoButton id="save" />
          <DemoButton id="bypass" formnovalidate="false" />
        </DemoForm></Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    let confirmations = 0
    let fetches = 0
    const focused: string[] = []
    const controller = new FormSubmissionController(
      session,
      {
        async fetch(request) {
          fetches += 1
          return {
            headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
            redirected: false,
            status: 204,
            text: async () => "",
            url: request.url,
          }
        },
      },
      {
        confirmation: {
          confirm: async () => {
            confirmations += 1
            return true
          },
        },
      },
    )
    const registry = registryFor(session, {
      focus: {
        blur() {},
        focus: (nodeKey) => {
          focused.push(nodeKey)
        },
        getFocusedId: () => focused.at(-1),
      },
      submissionController: controller,
    })
    const field = registry.register("id:field", {
      kind: "value",
      name: "profile[name]",
      value: "",
      validity: { message: "Name is required", valid: false },
    })
    const save = registry.register("id:save", { kind: "submitter", name: "commit", value: "save" })
    const bypass = registry.register("id:bypass", {
      kind: "submitter",
      name: "commit",
      value: "bypass",
    })

    expect(
      registry.requestPlan({
        protocol: { requestId: "validation-plan" },
        submitter: save.selection,
      }).entries,
    ).toEqual([
      { name: "profile[name]", value: "" },
      { name: "commit", value: "save" },
    ])
    expect(focused).toEqual([])

    for (const protocol of [
      { requestId: "" },
      { requestId: "\t" },
      { capabilityHash: "bad\nmetadata", requestId: "validation-invalid-capability" },
    ]) {
      expect(() =>
        registry.submit({
          protocol,
          submitter: save.selection,
        }),
      ).toThrow(RequestError)
    }
    expect(focused).toEqual([])
    expect(confirmations).toBe(0)
    expect(fetches).toBe(0)

    await expect(
      registry.submit({
        protocol: { requestId: "validation-blocked" },
        submitter: save.selection,
      }),
    ).resolves.toEqual({
      firstInvalid: { message: "Name is required", nodeKey: "id:field" },
      invalidControls: [{ message: "Name is required", nodeKey: "id:field" }],
      requestId: "validation-blocked",
      status: "invalid",
      submitterNodeKey: "id:save",
    })
    expect(focused).toEqual(["id:field"])
    expect(confirmations).toBe(0)
    expect(fetches).toBe(0)
    expect(registry.submissionState).toMatchObject({ busy: false, status: "idle" })
    expect(registry.submissionTerminalState).toEqual({ revision: 0, status: "none" })

    await expect(
      registry.submit({
        protocol: { requestId: "validation-bypassed" },
        submitter: bypass.selection,
      }),
    ).resolves.toMatchObject({ requestId: "validation-bypassed", status: "empty" })
    expect(confirmations).toBe(1)
    expect(fetches).toBe(1)

    field.update({
      kind: "value",
      name: "profile[name]",
      value: "Ada",
      validity: { valid: true },
    })
    await expect(
      registry.submit({
        protocol: { requestId: "validation-passed" },
        submitter: save.selection,
      }),
    ).resolves.toMatchObject({ requestId: "validation-passed", status: "empty" })
    expect(confirmations).toBe(2)
    expect(fetches).toBe(2)
  })

  test("revalidates live controls before retrying a safe terminal failure", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery><DemoForm id="form" action="/submit" data-turbo-confirm="Confirm">
          <DemoInput id="field" />
          <DemoButton id="save" />
        </DemoForm></Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    let confirmations = 0
    let fetches = 0
    const focused: string[] = []
    const controller = new FormSubmissionController(
      session,
      {
        async fetch(request) {
          fetches += 1
          if (fetches === 1) throw new Error("offline secret")
          return {
            headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
            redirected: false,
            status: 204,
            text: async () => "",
            url: request.url,
          }
        },
      },
      {
        confirmation: {
          confirm: async () => {
            confirmations += 1
            return true
          },
        },
      },
    )
    const registry = registryFor(session, {
      focus: {
        blur() {},
        focus: (nodeKey) => {
          focused.push(nodeKey)
        },
        getFocusedId: () => focused.at(-1),
      },
      submissionController: controller,
    })
    const field = registry.register("id:field", {
      kind: "value",
      name: "profile[name]",
      value: "Ada",
      validity: { valid: true },
    })
    const submitter = registry.register("id:save", {
      kind: "submitter",
      name: "commit",
      value: "save",
    })

    await expect(
      registry.submit({
        protocol: { requestId: "retry-initial" },
        submitter: submitter.selection,
      }),
    ).rejects.toBeInstanceOf(RequestError)
    const terminal = registry.submissionTerminalState
    expect(terminal).toMatchObject({
      requestId: "retry-initial",
      retryDisposition: "safe",
      status: "failed",
    })
    expect(confirmations).toBe(1)
    expect(fetches).toBe(1)

    field.update({
      kind: "value",
      name: "profile[name]",
      value: "",
      validity: { message: "Name is required", valid: false },
    })
    await expect(
      registry.retryFailure({ protocol: { requestId: "retry-invalid" } }),
    ).resolves.toMatchObject({
      firstInvalid: { nodeKey: "id:field" },
      requestId: "retry-invalid",
      status: "invalid",
      submitterNodeKey: "id:save",
    })
    expect(focused).toEqual(["id:field"])
    expect(confirmations).toBe(1)
    expect(fetches).toBe(1)
    expect(registry.submissionTerminalState).toBe(terminal)

    field.update({
      kind: "value",
      name: "profile[name]",
      value: "Grace",
      validity: { valid: true },
    })
    await expect(
      registry.retryFailure({ protocol: { requestId: "retry-valid" } }),
    ).resolves.toMatchObject({ requestId: "retry-valid", status: "empty" })
    expect(confirmations).toBe(2)
    expect(fetches).toBe(2)
  })

  test("keeps an invoked GET retry safe across live method changes", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><DemoForm id="form" action="/submit" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )
    let fetches = 0
    const controller = new FormSubmissionController(session, {
      async fetch(request) {
        fetches += 1
        if (fetches === 1) throw new Error("offline secret")
        return {
          headers: {},
          redirected: false,
          status: 204,
          text: async () => "",
          url: request.url,
        }
      },
    })
    const registry = registryFor(session, { submissionController: controller })

    await expect(
      registry.submit({ protocol: { requestId: "safe-get-initial" } }),
    ).rejects.toBeInstanceOf(RequestError)
    const terminal = registry.submissionTerminalState
    expect(terminal).toMatchObject({
      requestId: "safe-get-initial",
      retryDisposition: "safe",
      status: "failed",
    })
    expect(fetches).toBe(1)

    session.setAttribute("id:form", "method", "post")
    await expect(
      registry.retryFailure({ protocol: { requestId: "unsafe-live-retry" } }),
    ).rejects.toThrow("must remain a GET")
    expect(fetches).toBe(1)
    expect(registry.submissionTerminalState).toBe(terminal)

    session.removeAttribute("id:form", "method")
    await expect(
      registry.retryFailure({ protocol: { requestId: "safe-live-retry" } }),
    ).resolves.toMatchObject({ requestId: "safe-live-retry", status: "empty" })
    expect(fetches).toBe(2)
  })

  test("keeps an invoked GET retry safe after lifecycle mutation", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><DemoForm id="form" action="/submit" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )
    const lifecycle = new RequestLifecycle()
    lifecycle.subscribe("before-fetch-request", (event) => {
      if (
        event.detail.context.kind !== "form" ||
        event.detail.context.requestId !== "unsafe-lifecycle-retry"
      ) {
        return
      }
      event.detail.request.setMethod("POST")
      event.detail.request.setHeader("Accept", `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`)
      event.detail.request.setBody({
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "source=lifecycle",
      })
    })
    let fetches = 0
    const controller = new FormSubmissionController(
      session,
      {
        async fetch(request) {
          fetches += 1
          if (fetches === 1) throw new Error("offline secret")
          return {
            headers: {},
            redirected: false,
            status: 204,
            text: async () => "",
            url: request.url,
          }
        },
      },
      { requestLifecycle: lifecycle },
    )
    const registry = registryFor(session, { submissionController: controller })

    await expect(
      registry.submit({ protocol: { requestId: "safe-lifecycle-initial" } }),
    ).rejects.toBeInstanceOf(RequestError)
    await expect(
      registry.retryFailure({ protocol: { requestId: "unsafe-lifecycle-retry" } }),
    ).rejects.toThrow("must remain a GET")
    expect(fetches).toBe(1)
    expect(registry.submissionTerminalState).toMatchObject({
      requestId: "unsafe-lifecycle-retry",
      retryDisposition: "safe",
      status: "failed",
    })

    await expect(
      registry.retryFailure({ protocol: { requestId: "safe-lifecycle-retry" } }),
    ).resolves.toMatchObject({ requestId: "safe-lifecycle-retry", status: "empty" })
    expect(fetches).toBe(2)
  })

  test("allows an unsafe retry when the earlier failure happened before fetch", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><DemoForm id="form" action="/submit" method="post" /></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const lifecycle = new RequestLifecycle()
    const unsubscribe = lifecycle.subscribe("before-fetch-request", () => {
      throw new Error("pre-fetch listener secret")
    })
    let fetches = 0
    const controller = new FormSubmissionController(
      session,
      {
        async fetch(request) {
          fetches += 1
          return {
            headers: {},
            redirected: false,
            status: 204,
            text: async () => "",
            url: request.url,
          }
        },
      },
      { requestLifecycle: lifecycle },
    )
    const registry = registryFor(session, { submissionController: controller })

    await expect(
      registry.submit({ protocol: { requestId: "unsafe-prefetch-initial" } }),
    ).rejects.toBeInstanceOf(RequestError)
    expect(fetches).toBe(0)
    expect(registry.submissionTerminalState).toMatchObject({
      effectiveMethod: "POST",
      retryDisposition: "safe",
      status: "failed",
    })

    unsubscribe()
    await expect(
      registry.retryFailure({ protocol: { requestId: "unsafe-prefetch-retry" } }),
    ).resolves.toMatchObject({
      requestId: "unsafe-prefetch-retry",
      status: "empty",
      transportMethod: "POST",
    })
    expect(fetches).toBe(1)
  })

  test("honors form novalidate presence and fails closed when invalid focus is unavailable", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><DemoForm id="form" action="/submit" novalidate="false"><DemoInput id="field" /></DemoForm></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    let fetches = 0
    const controller = new FormSubmissionController(session, {
      async fetch(request) {
        fetches += 1
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 204,
          text: async () => "",
          url: request.url,
        }
      },
    })
    const registry = registryFor(session, { submissionController: controller })
    registry.register("id:field", {
      kind: "value",
      value: "",
      validity: { message: "Required", valid: false },
    })
    await expect(
      registry.submit({ protocol: { requestId: "form-novalidate" } }),
    ).resolves.toMatchObject({ requestId: "form-novalidate", status: "empty" })
    expect(fetches).toBe(1)

    session.removeAttribute("id:form", "novalidate")
    expect(() => registry.reportValidity()).toThrow(
      "Invalid form submission requires a configured focus adapter",
    )
    expect(() => registry.submit({ protocol: { requestId: "focus-unavailable" } })).toThrow(
      StateError,
    )
    expect(fetches).toBe(1)

    const throwingSession = formFixture()
    const throwing = registryFor(throwingSession, {
      focus: {
        blur() {},
        focus() {
          throw new Error("private native handle")
        },
        getFocusedId: () => undefined,
      },
    })
    throwing.register("id:first", {
      kind: "value",
      value: "",
      validity: { message: "Required", valid: false },
    })
    expect(() => throwing.reportValidity()).toThrow(
      "Form validation could not focus the first invalid control",
    )
    try {
      throwing.reportValidity()
    } catch (error) {
      expect(error).toBeInstanceOf(StateError)
      expect((error as StateError).context).toEqual({ target: "id:first" })
      expect((error as Error).message).not.toContain("private native handle")
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
    }

    const asynchronousSession = formFixture()
    const asynchronous = registryFor(asynchronousSession, {
      focus: {
        blur() {},
        async focus() {
          throw new Error("private asynchronous handle")
        },
        getFocusedId: () => undefined,
      },
    })
    asynchronous.register("id:first", {
      kind: "value",
      value: "",
      validity: { message: "Required", valid: false },
    })
    expect(() => asynchronous.reportValidity()).toThrow(
      "Form validation could not focus the first invalid control",
    )
    await Promise.resolve()
  })

  test("inherits live disabled fieldsets with the first direct legend exception", () => {
    const session = fieldsetFixture()
    const registry = new FormControlRegistry(session, "id:form", {
      formSemantics: FORM_SEMANTICS,
    })
    registry.register("id:external-disabled", {
      kind: "value",
      name: "external_disabled",
      value: "ignored",
    })
    registry.register("id:external-enabled", {
      kind: "value",
      name: "external_enabled",
      value: "outside",
    })
    const externalSubmitter = registry.register("id:external-submit", {
      kind: "submitter",
      name: "commit",
      value: "external",
    })
    registry.register("id:nested-legend-value", {
      kind: "value",
      name: "nested_legend",
      value: "ignored",
    })
    registry.register("id:outer-exempt", {
      kind: "value",
      name: "outer_exempt",
      value: "outer",
    })
    registry.register("id:direct-disabled", {
      directionality: { name: "direct_disabled.dir", value: "ltr" },
      disabled: true,
      kind: "value",
      name: "direct_disabled",
      value: "ignored",
    })
    registry.register("id:inner-exempt", {
      kind: "value",
      name: "inner_exempt",
      value: "inner",
    })
    registry.register("id:inner-disabled", {
      kind: "value",
      name: "inner_disabled",
      value: "ignored",
    })
    registry.register("id:second-legend-value", {
      kind: "value",
      name: "second_legend",
      value: "ignored",
    })
    registry.register("id:outer-body", {
      entries: [{ name: "outer_body", value: "ignored" }],
      kind: "entries",
      validity: { message: "Disabled outer entries are invalid", valid: false },
    })
    registry.register("id:live-value", {
      kind: "value",
      name: "live",
      value: "enabled",
    })
    const liveSubmitter = registry.register("id:live-submit", {
      kind: "submitter",
      name: "commit",
      value: "live",
    })

    expect(registry.successfulEntries({ submitter: externalSubmitter.selection })).toEqual([
      { name: "external_enabled", value: "outside" },
      { name: "outer_exempt", value: "outer" },
      { name: "inner_exempt", value: "inner" },
      { name: "live", value: "enabled" },
      { name: "commit", value: "external" },
    ])
    expect(registry.controlInheritedDisabled("id:outer-exempt")).toBe(false)
    expect(registry.controlInheritedDisabled("id:outer-body")).toBe(true)
    expect(registry.checkValidity()).toEqual({ invalidControls: [], valid: true })
    expect(() =>
      registry.register("id:not-associated", {
        kind: "value",
        name: "not_associated",
        value: "ignored",
      }),
    ).toThrow(/another form/)

    session.setAttribute("id:live-fieldset", "disabled", "false")
    expect(registry.controlInheritedDisabled("id:live-value")).toBe(true)
    expect(registry.successfulEntries()).toEqual([
      { name: "external_enabled", value: "outside" },
      { name: "outer_exempt", value: "outer" },
      { name: "inner_exempt", value: "inner" },
    ])
    expect(() =>
      registry.requestPlan({
        protocol: { requestId: "disabled-submitter" },
        submitter: liveSubmitter.selection,
      }),
    ).toThrow(/disabled/)
    session.removeAttribute("id:live-fieldset", "disabled")
    expect(registry.controlInheritedDisabled("id:live-value")).toBe(false)

    const inserted = parseExpoTurboDocument(
      '<DemoLegend id="new-first-legend"><DemoInput id="new-first-value" /></DemoLegend>',
    ).document.children.find(isElement)
    const outerFieldset = session.tree.getElementById("outer-fieldset")
    if (!inserted || !outerFieldset) throw new Error("fieldset insertion fixture is missing")
    session.mutate((tree) => tree.insertClones(outerFieldset, 0, [inserted]))
    registry.register("id:new-first-value", {
      kind: "value",
      name: "new_first",
      value: "new",
    })
    expect(registry.successfulEntries({ submitter: liveSubmitter.selection })).toEqual([
      { name: "external_enabled", value: "outside" },
      { name: "new_first", value: "new" },
      { name: "live", value: "enabled" },
      { name: "commit", value: "live" },
    ])
  })

  test("bars controls under semantic datalist ancestry without disabling them", () => {
    const session = datalistFixture()
    const registry = new FormControlRegistry(session, "id:form", {
      formSemantics: FORM_SEMANTICS,
    })
    registry.register("id:external-barred", {
      kind: "value",
      name: "external_barred",
      value: "ignored",
    })
    const externalSubmitter = registry.register("id:external-submit", {
      kind: "submitter",
      name: "commit",
      value: "ignored",
    })
    registry.register("id:external-enabled", {
      kind: "value",
      name: "external_enabled",
      value: "outside",
    })
    registry.register("id:before", { kind: "value", name: "before", value: "A" })
    registry.register("id:value", {
      entries: [{ name: "value", value: "ignored" }],
      kind: "entries",
      validity: { message: "Datalist entries are invalid", valid: false },
    })
    registry.register("id:checkable", {
      checked: true,
      kind: "checkable",
      name: "checkable",
      value: "ignored",
    })
    registry.register("id:select", {
      kind: "select",
      name: "select",
      options: [{ kind: "option", selected: true, value: "ignored" }],
    })
    registry.register("id:hidden", { kind: "hidden", name: "_charset_", value: "ignored" })
    registry.register("id:directional", {
      directionality: { name: "directional.dir", value: "ltr" },
      kind: "value",
      name: "directional",
      value: "ignored",
    })
    registry.register("id:fieldset-exempt", {
      kind: "value",
      name: "fieldset_exempt",
      value: "legend",
    })
    registry.register("id:after", { kind: "value", name: "after", value: "Z" })

    expect(registry.controlInheritedDisabled("id:value")).toBe(false)
    expect(registry.checkValidity()).toEqual({ invalidControls: [], valid: true })
    expect(registry.successfulEntries()).toEqual([
      { name: "external_enabled", value: "outside" },
      { name: "before", value: "A" },
      { name: "fieldset_exempt", value: "legend" },
      { name: "after", value: "Z" },
    ])
    expect(registry.requestPlan({ protocol: { requestId: "datalist" } })).toMatchObject({
      entries: [
        { name: "external_enabled", value: "outside" },
        { name: "before", value: "A" },
        { name: "fieldset_exempt", value: "legend" },
        { name: "after", value: "Z" },
      ],
      request: {
        body: {
          contentType: "application/x-www-form-urlencoded;charset=UTF-8",
          value: "external_enabled=outside&before=A&fieldset_exempt=legend&after=Z",
        },
        method: "POST",
        url: "https://example.test/submit",
      },
    })
    expect(
      registry.requestPlan({
        protocol: { requestId: "datalist-submitter" },
        submitter: externalSubmitter.selection,
      }),
    ).toMatchObject({
      entries: [
        { name: "external_enabled", value: "outside" },
        { name: "before", value: "A" },
        { name: "fieldset_exempt", value: "legend" },
        { name: "after", value: "Z" },
        { name: "commit", value: "ignored" },
      ],
      request: {
        body: {
          contentType: "application/x-www-form-urlencoded;charset=UTF-8",
          value: "external_enabled=outside&before=A&fieldset_exempt=legend&after=Z&commit=ignored",
        },
      },
    })
  })

  test("rejects malformed form semantics and forged container roles", () => {
    const session = fieldsetFixture()
    expect(
      () =>
        new FormControlRegistry(session, "id:form", {
          formSemantics: {} as never,
        }),
    ).toThrow(PropsError)
    const forged = new FormControlRegistry(session, "id:form", {
      formSemantics: {
        formContainerRole: () => "group" as never,
      },
    })
    forged.register("id:outer-body", { kind: "value", name: "value", value: "value" })
    expect(() => forged.successfulEntries()).toThrow(PropsError)
  })

  test("collects selected enabled options in authored order and inherits disabled groups", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const enabledOption = { kind: "option" as const, selected: true, value: "enabled" }
    const textOption = {
      kind: "option" as const,
      selected: true,
      textContent: " \tAlpha\n\fBeta\r ",
    }
    const disabledGroupOption = {
      disabled: false,
      kind: "option" as const,
      selected: true,
      value: "group-disabled",
    }
    const options: FormSelectItem[] = [
      { kind: "option", selected: true, value: "first" },
      {
        disabled: true,
        kind: "group",
        options: [disabledGroupOption],
      },
      {
        kind: "group",
        options: [
          enabledOption,
          { disabled: true, kind: "option", selected: true, textContent: "option disabled" },
          { kind: "option", selected: false, textContent: "unselected" },
          { kind: "option", selected: true, textContent: "ignored", value: "" },
          textOption,
          { kind: "option", selected: true, textContent: " \n\t " },
          { kind: "option", selected: true, textContent: "\u00a0Alpha\u00a0" },
          { kind: "option", selected: true, value: "enabled" },
        ],
      },
    ]

    const submitter = registry.register("id:save", {
      kind: "submitter",
      name: "commit",
      value: "save",
    })
    registry.register("id:first", { kind: "value", name: "before", value: "A" })
    registry.register("id:second", { kind: "value", name: "inside", value: "B" })
    const select = registry.register("id:multiple", {
      kind: "select",
      name: "choices[]",
      options,
    })

    enabledOption.value = "mutated"
    enabledOption.selected = false
    textOption.textContent = "mutated"
    disabledGroupOption.value = "mutated-disabled"
    options.push({ kind: "option", selected: true, value: "late" })

    expect(registry.successfulEntries({ submitter: submitter.selection })).toEqual([
      { name: "before", value: "A" },
      { name: "inside", value: "B" },
      { name: "choices[]", value: "first" },
      { name: "choices[]", value: "enabled" },
      { name: "choices[]", value: "" },
      { name: "choices[]", value: "Alpha Beta" },
      { name: "choices[]", value: "" },
      { name: "choices[]", value: "\u00a0Alpha\u00a0" },
      { name: "choices[]", value: "enabled" },
      { name: "commit", value: "save" },
    ])

    const updatedOption = { kind: "option" as const, selected: true, value: "updated" }
    select.update({
      kind: "select",
      name: "choice",
      options: [
        { kind: "option", selected: false, value: "ignored" },
        { kind: "group", options: [updatedOption] },
      ],
    })
    updatedOption.value = "mutated-after-update"
    expect(registry.successfulEntries()).toEqual([
      { name: "before", value: "A" },
      { name: "inside", value: "B" },
      { name: "choice", value: "updated" },
    ])

    select.update({
      disabled: true,
      kind: "select",
      name: "choice",
      options: [{ kind: "option", selected: true, value: "suppressed" }],
    })
    expect(registry.successfulEntries()).toEqual([
      { name: "before", value: "A" },
      { name: "inside", value: "B" },
    ])
  })

  test("requires headless controls to re-register after explicit owner changes", () => {
    const session = externalFormFixture()
    const registry = registryFor(session)
    const otherRegistry = new FormControlRegistry(session, "id:other-form")
    const registration = registry.register("id:before", {
      kind: "value",
      name: "before",
      value: "A",
    })

    session.setAttribute("id:before", "form", "other-form")

    expect(() => registration.update({ kind: "value", name: "before", value: "stale" })).toThrow(
      /no longer owns its form/,
    )
    registration.unregister()
    otherRegistry.register("id:before", { kind: "value", name: "before", value: "B" })
    expect(registry.successfulEntries()).toEqual([])
    expect(otherRegistry.successfulEntries()).toEqual([{ name: "before", value: "B" }])
  })

  test("invalidates a proposal when its external submitter changes form owner", () => {
    const session = externalFormFixture()
    const registry = registryFor(session)
    const submitter = registry.register("id:external-submit", {
      kind: "submitter",
      name: "commit",
      value: "external",
    })
    const proposal = registry.submissionProposal({
      protocol: { requestId: "external-owner" },
      submitter: submitter.selection,
    })

    session.setAttribute("id:external-submit", "form", "other-form")

    expect(() => assertActiveFormSubmissionProposal(session, proposal)).toThrow(
      /submitter no longer owns its form/,
    )
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

  test("emits explicit hidden and value directionality entries in XML order", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const directionality: { name: string; value: "ltr" | "rtl" } = {
      name: "comment.dir",
      value: "rtl",
    }
    const hiddenDirectionality: { name: string; value: "ltr" | "rtl" } = {
      name: "charset.dir",
      value: "ltr",
    }

    const hidden = registry.register("id:first", {
      directionality: hiddenDirectionality,
      kind: "hidden",
      name: "_CHARSET_",
      value: "ignored",
    })
    const directional = registry.register("id:second", {
      directionality,
      kind: "value",
      name: "comment",
      value: "مرحبا",
    })
    registry.register("id:unchecked", {
      directionality: { name: "empty.dir", value: "ltr" },
      kind: "value",
      name: "empty",
      value: "",
    })
    registry.register("id:checked", {
      kind: "value",
      name: "_charset_",
      value: "caller-value",
    })
    registry.register("id:multiple", {
      directionality: { name: "token.dir", value: "rtl" },
      kind: "hidden",
      name: "token",
    })

    hiddenDirectionality.name = "changed-hidden.dir"
    hiddenDirectionality.value = "rtl"
    directionality.name = "changed.dir"
    directionality.value = "ltr"
    const entries = registry.successfulEntries()
    expect(entries).toEqual([
      { name: "_CHARSET_", value: "UTF-8" },
      { name: "charset.dir", value: "ltr" },
      { name: "comment", value: "مرحبا" },
      { name: "comment.dir", value: "rtl" },
      { name: "empty", value: "" },
      { name: "empty.dir", value: "ltr" },
      { name: "_charset_", value: "caller-value" },
      { name: "token", value: "" },
      { name: "token.dir", value: "rtl" },
    ])
    expect(Object.isFrozen(entries)).toBe(true)
    expect(entries.every(Object.isFrozen)).toBe(true)

    directional.update({
      directionality: { name: "comment-direction", value: "ltr" },
      kind: "value",
      name: "comment",
      value: "hello",
    })
    hidden.update({
      directionality: { name: "charset-direction", value: "rtl" },
      kind: "hidden",
      name: "_charset_",
    })
    expect(registry.successfulEntries()).toEqual([
      { name: "_charset_", value: "UTF-8" },
      { name: "charset-direction", value: "rtl" },
      { name: "comment", value: "hello" },
      { name: "comment-direction", value: "ltr" },
      { name: "empty", value: "" },
      { name: "empty.dir", value: "ltr" },
      { name: "_charset_", value: "caller-value" },
      { name: "token", value: "" },
      { name: "token.dir", value: "rtl" },
    ])
  })

  test("models explicit hidden values and hidden _charset_ replacement", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const submitter = registry.register("id:save", {
      kind: "submitter",
      name: "_charset_",
      value: "submitter-value",
    })

    registry.register("id:first", {
      kind: "hidden",
      name: "_CHARSET_",
      value: "caller-value",
    })
    registry.register("id:second", { kind: "hidden", name: "token" })
    registry.register("id:unchecked", {
      disabled: true,
      kind: "hidden",
      name: "_charset_",
      value: "ignored",
    })
    registry.register("id:checked", {
      kind: "value",
      name: "_charset_",
      value: "ordinary-value",
    })
    registry.register("id:multiple", {
      kind: "hidden",
      name: "_CHARſET_",
      value: "non-ascii-name",
    })
    registry.register("id:disabled", {
      disabled: true,
      kind: "hidden",
      name: "disabled",
      value: "ignored",
    })
    registry.register("id:unnamed", { kind: "hidden", value: "ignored" })
    registry.register("id:empty-name", { kind: "hidden", name: "", value: "ignored" })

    expect(registry.successfulEntries({ submitter: submitter.selection })).toEqual([
      { name: "_CHARSET_", value: "UTF-8" },
      { name: "token", value: "" },
      { name: "_charset_", value: "ordinary-value" },
      { name: "_CHARſET_", value: "non-ascii-name" },
      { name: "_charset_", value: "submitter-value" },
    ])
  })

  test("omits hidden charset and directionality entries with their unsuccessful owner", () => {
    const session = formFixture()
    const registry = registryFor(session)

    registry.register("id:first", {
      directionality: { name: "disabled.dir", value: "rtl" },
      disabled: true,
      kind: "hidden",
      name: "_charset_",
      value: "ignored",
    })
    registry.register("id:second", {
      directionality: { name: "missing.dir", value: "ltr" },
      kind: "value",
      value: "missing",
    })
    registry.register("id:checked", {
      directionality: { name: "empty.dir", value: "rtl" },
      kind: "value",
      name: "",
      value: "empty",
    })
    registry.register("id:multiple", {
      directionality: { name: "disabled.dir", value: "ltr" },
      disabled: true,
      kind: "value",
      name: "disabled",
      value: "disabled",
    })

    expect(registry.successfulEntries()).toEqual([])
  })

  test("rejects malformed hidden and directionality descriptors", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const malformed: unknown[] = [
      { kind: "hidden", name: "token", value: 7 },
      { directionality: null, kind: "hidden", name: "token" },
      { directionality: { name: "", value: "ltr" }, kind: "hidden", name: "token" },
      { directionality: { name: "token.dir", value: "auto" }, kind: "hidden", name: "token" },
      { directionality: null, kind: "value", name: "value", value: "value" },
      { directionality: [], kind: "value", name: "value", value: "value" },
      { directionality: {}, kind: "value", name: "value", value: "value" },
      {
        directionality: { name: 7, value: "ltr" },
        kind: "value",
        name: "value",
        value: "value",
      },
      {
        directionality: { name: "", value: "ltr" },
        kind: "value",
        name: "value",
        value: "value",
      },
      {
        directionality: { name: "value.dir", value: "auto" },
        kind: "value",
        name: "value",
        value: "value",
      },
      {
        directionality: { name: "value.dir", value: "RTL" },
        kind: "value",
        name: "value",
        value: "value",
      },
    ]

    for (const descriptor of malformed) {
      expect(() => registry.register("id:second", descriptor as FormControlDescriptor)).toThrow(
        PropsError,
      )
    }
  })

  test("rejects malformed multi-name entry-list descriptors", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const sparseEntries = new Array<{ name: string; value: string }>(1)
    const malformed: unknown[] = [
      { kind: "entries" },
      { entries: null, kind: "entries" },
      { entries: sparseEntries, kind: "entries" },
      { entries: [null], kind: "entries" },
      { entries: [{ name: 7, value: "value" }], kind: "entries" },
      { entries: [{ name: "field", value: 7 }], kind: "entries" },
      { entries: [{ name: "file", value: { uri: "file:///private" } }], kind: "entries" },
      { entries: [{ extra: true, name: "field", value: "value" }], kind: "entries" },
      { entries: [], kind: "entries", name: "container" },
      { entries: [], kind: "entries", value: { uri: "file:///private" } },
      { directionality: { name: "field.dir", value: "ltr" }, entries: [], kind: "entries" },
      { entries: [], kind: "entries", typo: true },
    ]

    for (const descriptor of malformed) {
      expect(() => registry.register("id:multiple", descriptor as FormControlDescriptor)).toThrow(
        PropsError,
      )
    }
  })

  test("strictly admits frozen host-owned validity snapshots", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const registration = registry.register("id:first", {
      kind: "value",
      value: "Ada",
      validity: { valid: true },
    })
    expect(registry.checkValidity()).toEqual({ invalidControls: [], valid: true })

    for (const validity of [
      null,
      { valid: "false" },
      { valid: false },
      { message: "", valid: false },
      { message: "unexpected", valid: true },
      { extra: true, valid: true },
      { extra: true, message: "Required", valid: false },
    ]) {
      expect(() =>
        registration.update({
          kind: "value",
          value: "",
          validity,
        } as unknown as FormControlDescriptor),
      ).toThrow(PropsError)
    }

    registration.update({
      kind: "value",
      value: "",
      validity: { message: "Required", valid: false },
    })
    const invalid = registry.checkValidity()
    if (invalid.valid) throw new Error("invalid form fixture unexpectedly passed")
    expect(Object.isFrozen(invalid.firstInvalid)).toBe(true)
    expect(invalid.firstInvalid).toEqual({ message: "Required", nodeKey: "id:first" })

    expect(() =>
      registry.register("id:unchecked", {
        kind: "hidden",
        validity: { message: "Unsupported", valid: false },
      } as unknown as FormControlDescriptor),
    ).toThrow(PropsError)
    expect(() =>
      registry.register("id:save", {
        kind: "submitter",
        validity: { message: "Unsupported", valid: false },
      } as unknown as FormControlDescriptor),
    ).toThrow(PropsError)
  })

  test("rejects malformed select option snapshots", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const sparseOptions = new Array<FormSelectItem>(1)
    const sparseGroupOptions = new Array<{
      kind: "option"
      selected: boolean
      value: string
    }>(1)
    const malformed: unknown[] = [
      { kind: "select", name: "choice" },
      { kind: "select", name: "choice", options: null },
      { kind: "select", name: "choice", options: [null] },
      { kind: "select", name: "choice", options: sparseOptions },
      { kind: "select", name: "choice", options: [{ kind: "unknown" }] },
      {
        kind: "select",
        name: "choice",
        options: [{ kind: "option", selected: true }],
      },
      {
        kind: "select",
        name: "choice",
        options: [{ kind: "option", selected: "true", value: "one" }],
      },
      {
        kind: "select",
        name: "choice",
        options: [{ kind: "option", selected: true, value: 1 }],
      },
      {
        kind: "select",
        name: "choice",
        options: [{ kind: "option", selected: true, textContent: 1 }],
      },
      {
        kind: "select",
        name: "choice",
        options: [{ kind: "option", selected: true, textContent: 1, value: "one" }],
      },
      {
        kind: "select",
        name: "choice",
        options: [{ disabled: "false", kind: "option", selected: true, value: "one" }],
      },
      {
        kind: "select",
        name: "choice",
        options: [{ kind: "group", options: null }],
      },
      {
        kind: "select",
        name: "choice",
        options: [{ kind: "group", options: sparseGroupOptions }],
      },
      {
        kind: "select",
        name: "choice",
        options: [{ disabled: "true", kind: "group", options: [] }],
      },
      {
        kind: "select",
        name: "choice",
        options: [
          {
            kind: "group",
            options: [{ kind: "group", options: [] }],
          },
        ],
      },
    ]

    for (const descriptor of malformed) {
      expect(() => registry.register("id:multiple", descriptor as FormControlDescriptor)).toThrow(
        PropsError,
      )
    }
  })

  test("preserves selected option entries through GET and URL-encoded request planning", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><DemoForm id="form" action="/search?stale=1"><DemoSelect id="select" /></DemoForm></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const registry = registryFor(session)
    registry.register("id:select", {
      kind: "select",
      name: "choice[]",
      options: [
        { kind: "option", selected: true, textContent: "  one\n " },
        { disabled: true, kind: "option", selected: true, value: "ignored" },
        { kind: "option", selected: true, value: "" },
      ],
    })

    const get = registry.requestPlan({ protocol: { requestId: "select-get" } })
    expect(get.entries).toEqual([
      { name: "choice[]", value: "one" },
      { name: "choice[]", value: "" },
    ])
    expect(get.request.url).toBe("https://example.test/search?choice%5B%5D=one&choice%5B%5D=")

    session.setAttribute("id:form", "method", "post")
    expect(registry.requestPlan({ protocol: { requestId: "select-post" } }).request).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "choice%5B%5D=one&choice%5B%5D=",
      },
      method: "POST",
      url: "https://example.test/search?stale=1",
    })
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
    expect(registry.requestPlan({ protocol: { requestId: "form-enctype" } })).toMatchObject({
      effectiveMethod: "POST",
      encoding: "text/plain",
      entries: [{ name: "profile[name]", value: "After" }],
      request: {
        body: {
          contentType: "text/plain",
          value: "profile[name]=After\r\n",
        },
        method: "POST",
        url: "https://example.test/form",
      },
      sourceMethod: "POST",
    })
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

  test("preserves hidden charset and directionality entries through GET request planning", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery><DemoForm id="form" action="/search?stale=1">
          <DemoInput id="charset" />
          <DemoInput id="query" />
        </DemoForm></Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    const registry = registryFor(session)
    registry.register("id:charset", {
      directionality: { name: "charset.dir", value: "rtl" },
      kind: "hidden",
      name: "_CHARSET_",
      value: "ignored",
    })
    registry.register("id:query", {
      directionality: { name: "query.dir", value: "ltr" },
      kind: "value",
      name: "query",
      value: "hello world",
    })

    const plan = registry.requestPlan({ protocol: { requestId: "charset-get" } })
    expect(plan.entries).toEqual([
      { name: "_CHARSET_", value: "UTF-8" },
      { name: "charset.dir", value: "rtl" },
      { name: "query", value: "hello world" },
      { name: "query.dir", value: "ltr" },
    ])
    expect(plan.request).toMatchObject({
      method: "GET",
      url: "https://example.test/search?_CHARSET_=UTF-8&charset.dir=rtl&query=hello+world&query.dir=ltr",
    })

    session.setAttribute("id:form", "method", "post")
    const unsafe = registry.requestPlan({ protocol: { requestId: "charset-post" } })
    expect(unsafe.request).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "_CHARSET_=UTF-8&charset.dir=rtl&query=hello+world&query.dir=ltr",
      },
      method: "POST",
      url: "https://example.test/search?stale=1",
    })
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

    let forbiddenProtocolReads = 0
    expect(() =>
      registry.requestPlan({
        protocol: {
          frameId: "forged",
          get requestId() {
            forbiddenProtocolReads += 1
            throw new Error("sensitive forbidden metadata detail")
          },
        },
      } as never),
    ).toThrow(/derive Turbo-Frame metadata/)
    expect(forbiddenProtocolReads).toBe(0)

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

  test("stages and redacts active request inputs before composing builder plans", () => {
    const registry = registryFor(formFixture())
    const planners = [
      (options: unknown) => registry.requestPlan(options as never),
      (options: unknown) => registry.submissionProposal(options as never).plan,
    ]

    for (const compose of planners) {
      const reads: Record<string, number> = {}
      const protocol = {
        capabilityHash: "capability-before",
        requestId: "request-before",
      }
      const options = {
        get protocol() {
          reads.protocol = (reads.protocol ?? 0) + 1
          return protocol
        },
        get signal() {
          reads.signal = (reads.signal ?? 0) + 1
          protocol.capabilityHash = "capability-after"
          protocol.requestId = "request-after"
          return undefined
        },
        get submitter() {
          reads.submitter = (reads.submitter ?? 0) + 1
          return undefined
        },
      }

      expect(compose(options).request.headers).toMatchObject({
        "X-Expo-Turbo-Capabilities": "capability-before",
        "X-Turbo-Request-Id": "request-before",
      })
      expect(reads).toEqual({ protocol: 1, signal: 1, submitter: 1 })
    }

    const revoked = <T extends object>(value: T): T => {
      const pair = Proxy.revocable(value, {})
      pair.revoke()
      return pair.proxy
    }
    const sensitiveProtocolOption = new Proxy(
      { protocol: { requestId: "request" } },
      {
        get(target, key, receiver) {
          if (key === "protocol") throw new Error("sensitive options detail")
          return Reflect.get(target, key, receiver)
        },
      },
    )
    const sensitiveRequestId = {
      get requestId(): string {
        throw new Error("sensitive protocol detail")
      },
    }
    const hostileOptions = [
      revoked({}),
      sensitiveProtocolOption,
      { protocol: revoked({}) },
      { protocol: sensitiveRequestId },
      {
        protocol: new Proxy(
          { requestId: "request" },
          {
            has() {
              throw new Error("sensitive protocol ownership detail")
            },
          },
        ),
      },
    ]
    const activeCalls = [
      (options: unknown) => registry.requestPlan(options as never),
      (options: unknown) => registry.submissionProposal(options as never),
      (options: unknown) => registry.submit(options as never),
      (options: unknown) => registry.retryFailure(options as never),
    ]

    for (const run of activeCalls) {
      for (const options of hostileOptions) {
        let failure: unknown
        try {
          run(options)
        } catch (error) {
          failure = error
        }
        expect(failure).toBeInstanceOf(RequestError)
        if (!(failure instanceof RequestError)) continue
        expect(`${failure.message} ${JSON.stringify(failure.context)}`).not.toContain("sensitive")
      }
    }

    const revokedSelection = revoked({})
    for (const run of activeCalls.slice(0, 3)) {
      let failure: unknown
      try {
        run({
          protocol: { requestId: "revoked-selection" },
          submitter: revokedSelection,
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(TargetError)
      if (!(failure instanceof TargetError)) continue
      expect(`${failure.message} ${JSON.stringify(failure.context)}`).not.toContain("sensitive")
    }
  })

  test("retains one-read active protocol snapshots through submit and retry dispatch", async () => {
    const session = formFixture()
    const observed: Array<{
      readonly capabilityHash: string | undefined
      readonly requestId: string | undefined
    }> = []
    const controller = new FormSubmissionController(session, {
      async fetch(request) {
        const requestId = request.headers["X-Turbo-Request-Id"]
        observed.push({
          capabilityHash: request.headers["X-Expo-Turbo-Capabilities"],
          requestId,
        })
        if (requestId === "retry-source") throw new Error("private network detail")
        return {
          headers: {},
          redirected: false,
          status: 204,
          text: async () => "",
          url: request.url,
        }
      },
    })
    const registry = registryFor(session, { submissionController: controller })
    const submitReads: Record<string, number> = {}
    const submitProtocol = {
      get capabilityHash() {
        submitReads.capabilityHash = (submitReads.capabilityHash ?? 0) + 1
        return submitReads.capabilityHash === 1 ? "submit-capability" : "changed-capability"
      },
      get requestId() {
        submitReads.requestId = (submitReads.requestId ?? 0) + 1
        return submitReads.requestId === 1 ? "submit-live" : "changed-request"
      },
    }

    await expect(
      registry.submit({
        get protocol() {
          submitReads.protocol = (submitReads.protocol ?? 0) + 1
          return submitProtocol
        },
        get submitter() {
          submitReads.submitter = (submitReads.submitter ?? 0) + 1
          return undefined
        },
      } as never),
    ).resolves.toMatchObject({ requestId: "submit-live", status: "empty" })
    expect(submitReads).toEqual({
      capabilityHash: 1,
      protocol: 1,
      requestId: 1,
      submitter: 1,
    })
    expect(observed.at(-1)).toEqual({
      capabilityHash: "submit-capability",
      requestId: "submit-live",
    })

    await expect(
      registry.submit({ protocol: { requestId: "retry-source" } }),
    ).rejects.toBeInstanceOf(RequestError)
    const retryReads: Record<string, number> = {}
    const retryProtocol = {
      get capabilityHash() {
        retryReads.capabilityHash = (retryReads.capabilityHash ?? 0) + 1
        return retryReads.capabilityHash === 1 ? "retry-capability" : "changed-capability"
      },
      get requestId() {
        retryReads.requestId = (retryReads.requestId ?? 0) + 1
        return retryReads.requestId === 1 ? "retry-live" : "changed-request"
      },
    }
    await expect(
      registry.retryFailure({
        get protocol() {
          retryReads.protocol = (retryReads.protocol ?? 0) + 1
          return retryProtocol
        },
      }),
    ).resolves.toMatchObject({ requestId: "retry-live", status: "empty" })
    expect(retryReads).toEqual({ capabilityHash: 1, protocol: 1, requestId: 1 })
    expect(observed.at(-1)).toEqual({
      capabilityHash: "retry-capability",
      requestId: "retry-live",
    })

    const throwingPresence = new Proxy(
      { protocol: { requestId: "presence" } },
      {
        has() {
          throw new Error("sensitive option ownership detail")
        },
      },
    )
    try {
      registry.submit(throwingPresence)
      throw new Error("throwing option-ownership fixture was accepted")
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      if (!(error instanceof RequestError)) throw error
      expect(`${error.message} ${JSON.stringify(error.context)}`).not.toContain("sensitive")
    }
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
      entries: [{ name: "field", value: "old" }],
      kind: "entries",
    })

    const source = parseExpoTurboDocument('<DemoInput id="first" />').getElementById("first")
    if (!source) throw new Error("replacement fixture is missing")
    session.mutate((tree) => tree.replaceNodeWithClones(first, [source]))

    expect(() =>
      registration.update({
        entries: [{ name: "field", value: "stale" }],
        kind: "entries",
      }),
    ).toThrow(StateError)
    expect(registry.successfulEntries()).toEqual([])
    registry.register("id:first", {
      entries: [{ name: "field", value: "new" }],
      kind: "entries",
    })
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

  test("rebinds surviving external controls to a same-key form replacement", () => {
    const session = externalFormFixture()
    const forms = new DocumentFormControls(session)
    const form = session.tree.getElementById("form")
    if (!form) throw new Error("form fixture is missing")
    const original = forms.controlsFor(form.key)
    original.register("id:before", { kind: "value", name: "before", value: "old" })
    const replacement = parseExpoTurboDocument(
      '<DemoForm id="form"><DemoInput id="fresh" /></DemoForm>',
    ).getElementById("form")
    if (!replacement) throw new Error("replacement form fixture is missing")

    session.mutate((tree) => tree.replaceNodeWithClones(form, [replacement]))

    expect(original.isDisposed).toBe(true)
    const rebound = forms.controlsFor("id:form")
    rebound.register("id:before", { kind: "value", name: "before", value: "current" })
    rebound.register("id:fresh", { kind: "value", name: "fresh", value: "new" })
    expect(rebound.successfulEntries()).toEqual([
      { name: "before", value: "current" },
      { name: "fresh", value: "new" },
    ])
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

const invalidHidden: FormControlDescriptor = {
  kind: "hidden",
  name: "token",
  // @ts-expect-error Hidden values must be strings when present.
  value: 7,
}
void invalidHidden

const invalidSubmitterDirectionality: FormControlDescriptor = {
  // @ts-expect-error Turbo manually appends only the submitter name and value.
  directionality: { name: "commit.dir", value: "rtl" },
  kind: "submitter",
  name: "commit",
  value: "save",
}
void invalidSubmitterDirectionality

const invalidHiddenValidity: FormControlDescriptor = {
  kind: "hidden",
  name: "token",
  // @ts-expect-error Hidden controls are barred from constraint validation.
  validity: { message: "Required", valid: false },
}
void invalidHiddenValidity

const invalidSubmitterValidity: FormControlDescriptor = {
  kind: "submitter",
  // @ts-expect-error Submitters are barred from constraint validation.
  validity: { message: "Required", valid: false },
}
void invalidSubmitterValidity

const invalidValidMessage: FormControlDescriptor = {
  kind: "value",
  value: "value",
  // @ts-expect-error Valid controls cannot carry invalid-state message copy.
  validity: { message: "Unexpected", valid: true },
}
void invalidValidMessage

// @ts-expect-error Entry-list controls own names per entry, not on the container.
const invalidNamedEntryList: FormControlDescriptor = {
  entries: [],
  kind: "entries",
  name: "container",
}
void invalidNamedEntryList

const invalidBinaryEntryList: FormControlDescriptor = {
  entries: [
    {
      name: "file",
      // @ts-expect-error Entry-list values are strings; native files require upload transport.
      value: 7,
    },
  ],
  kind: "entries",
}
void invalidBinaryEntryList

// @ts-expect-error Select options require an explicit value or a text snapshot.
const missingSelectOptionValue: FormSelectOption = { kind: "option", selected: true }
void missingSelectOptionValue

const invalidSelectOptionText: FormSelectOption = {
  kind: "option",
  selected: true,
  // @ts-expect-error Select option text snapshots must be strings.
  textContent: 7,
}
void invalidSelectOptionText

const automaticDirectionality: FormControlDirectionality = {
  name: "field.dir",
  // @ts-expect-error Directionality snapshots must already resolve to ltr or rtl.
  value: "auto",
}
void automaticDirectionality
