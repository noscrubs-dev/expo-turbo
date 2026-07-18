import { describe, expect, test } from "bun:test"

import { PropsError, RegistryError, RequestError, StateError, TargetError } from "./errors"
import { assertActiveFormSubmissionProposal } from "./form-submission-proposal"
import {
  DocumentFormControls,
  type FormControlDescriptor,
  type FormControlDirectionality,
  type FormControlRegistration,
  FormControlRegistry,
  type FormControlSelection,
  type FormSelectItem,
} from "./forms"
import { parseExpoTurboDocument } from "./parser"
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
            <DemoInput id="charset" />
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
    registry.register("id:before", { kind: "value", name: "before", value: "A" })
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
      directionality: { name: "outer_body.dir", value: "rtl" },
      kind: "value",
      name: "outer_body",
      value: "ignored",
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
    registry.register("id:value", { kind: "value", name: "value", value: "ignored" })
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
    registry.register("id:charset", { kind: "charset", name: "_charset_" })
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
          { disabled: true, kind: "option", selected: true, value: "option-disabled" },
          { kind: "option", selected: false, value: "unselected" },
          { kind: "option", selected: true, value: "" },
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
    disabledGroupOption.value = "mutated-disabled"
    options.push({ kind: "option", selected: true, value: "late" })

    expect(registry.successfulEntries({ submitter: submitter.selection })).toEqual([
      { name: "before", value: "A" },
      { name: "inside", value: "B" },
      { name: "choices[]", value: "first" },
      { name: "choices[]", value: "enabled" },
      { name: "choices[]", value: "" },
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

  test("emits explicit UTF-8 charset and directionality entries in XML order", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const directionality: { name: string; value: "ltr" | "rtl" } = {
      name: "comment.dir",
      value: "rtl",
    }

    registry.register("id:first", { kind: "charset", name: "_CHARSET_" })
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
    registry.register("id:multiple", { kind: "charset", name: "_charset_" })

    directionality.name = "changed.dir"
    directionality.value = "ltr"
    const entries = registry.successfulEntries()
    expect(entries).toEqual([
      { name: "_CHARSET_", value: "UTF-8" },
      { name: "comment", value: "مرحبا" },
      { name: "comment.dir", value: "rtl" },
      { name: "empty", value: "" },
      { name: "empty.dir", value: "ltr" },
      { name: "_charset_", value: "caller-value" },
      { name: "_charset_", value: "UTF-8" },
    ])
    expect(Object.isFrozen(entries)).toBe(true)
    expect(entries.every(Object.isFrozen)).toBe(true)

    directional.update({
      directionality: { name: "comment-direction", value: "ltr" },
      kind: "value",
      name: "comment",
      value: "hello",
    })
    expect(registry.successfulEntries()).toEqual([
      { name: "_CHARSET_", value: "UTF-8" },
      { name: "comment", value: "hello" },
      { name: "comment-direction", value: "ltr" },
      { name: "empty", value: "" },
      { name: "empty.dir", value: "ltr" },
      { name: "_charset_", value: "caller-value" },
      { name: "_charset_", value: "UTF-8" },
    ])
  })

  test("omits charset and directionality entries with their unsuccessful owner", () => {
    const session = formFixture()
    const registry = registryFor(session)

    registry.register("id:first", {
      disabled: true,
      kind: "charset",
      name: "_charset_",
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

  test("rejects malformed charset and directionality descriptors", () => {
    const session = formFixture()
    const registry = registryFor(session)
    const malformed: unknown[] = [
      { kind: "charset" },
      { kind: "charset", name: "" },
      { kind: "charset", name: 7 },
      { kind: "charset", name: "charset" },
      { kind: "charset", name: "_charset_x" },
      { kind: "charset", name: "_CHARſET_" },
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
        { kind: "option", selected: true, value: "one" },
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

  test("preserves charset and directionality entries through GET request planning", () => {
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
    registry.register("id:charset", { kind: "charset", name: "_CHARSET_" })
    registry.register("id:query", {
      directionality: { name: "query.dir", value: "ltr" },
      kind: "value",
      name: "query",
      value: "hello world",
    })

    const plan = registry.requestPlan({ protocol: { requestId: "charset-get" } })
    expect(plan.entries).toEqual([
      { name: "_CHARSET_", value: "UTF-8" },
      { name: "query", value: "hello world" },
      { name: "query.dir", value: "ltr" },
    ])
    expect(plan.request).toMatchObject({
      method: "GET",
      url: "https://example.test/search?_CHARSET_=UTF-8&query=hello+world&query.dir=ltr",
    })

    session.setAttribute("id:form", "method", "post")
    const unsafe = registry.requestPlan({ protocol: { requestId: "charset-post" } })
    expect(unsafe.request).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "_CHARSET_=UTF-8&query=hello+world&query.dir=ltr",
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

// @ts-expect-error Charset descriptors require an authored name.
const unnamedCharset: FormControlDescriptor = { kind: "charset" }
void unnamedCharset

const automaticDirectionality: FormControlDirectionality = {
  name: "field.dir",
  // @ts-expect-error Directionality snapshots must already resolve to ltr or rtl.
  value: "auto",
}
void automaticDirectionality
