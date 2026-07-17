import { describe, expect, test } from "bun:test"

import { PropsError, RegistryError, StateError, TargetError } from "./errors"
import {
  type FormControlDescriptor,
  type FormControlRegistration,
  FormControlRegistry,
} from "./forms"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"

function formFixture(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(`<Gallery>
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
    </Gallery>`),
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

    registry.register("id:save", { kind: "submitter", name: "commit" })
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

    expect(registry.successfulEntries({ submitterNodeKey: "id:save" })).toEqual([
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

    const frozen = registry.successfulEntries({ submitterNodeKey: "id:save" })
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

  test("requires an exact registered submitter owned by this form", () => {
    const session = formFixture()
    const registry = registryFor(session)
    registry.register("id:first", { kind: "value", name: "field", value: "value" })
    registry.register("id:save", { kind: "submitter", name: "commit", value: "save" })
    registry.register("id:alternate", {
      disabled: true,
      kind: "submitter",
      name: "commit",
      value: "disabled",
    })

    expect(registry.successfulEntries({ submitterNodeKey: "id:save" })).toEqual([
      { name: "field", value: "value" },
      { name: "commit", value: "save" },
    ])
    expect(() => registry.successfulEntries({ submitterNodeKey: "id:first" })).toThrow(TargetError)
    expect(() => registry.successfulEntries({ submitterNodeKey: "id:alternate" })).toThrow(
      /disabled/,
    )
    expect(() => registry.successfulEntries({ submitterNodeKey: "id:foreign" })).toThrow(
      TargetError,
    )
    expect(() => registry.successfulEntries({ submitterNodeKey: "missing" })).toThrow(TargetError)
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

// Compile-time coverage: registration handles do not expose a mutable node key.
function updateRegistration(registration: FormControlRegistration): void {
  // @ts-expect-error Form control registration identity is immutable.
  registration.nodeKey = "other"
}
void updateRegistration
