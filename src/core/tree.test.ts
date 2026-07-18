import { describe, expect, test } from "bun:test"

import { ParseError, TargetError } from "./errors"
import { parseExpoTurboDocument, parseTurboStreamFragment } from "./parser"
import { querySelectorAll } from "./selectors"
import { attributeValue, isElement, nodeTextContent, renderedNodeTextContent } from "./tree"

const documentXml = `<Gallery xmlns:demo="urn:expo-turbo:demo">
  <DemoCard id="alpha" class="featured primary" data-state="ready">
    <DemoText>Hello <demo:Emphasis>world</demo:Emphasis>!</DemoText>
    <!-- inspector-only -->
    <![CDATA[raw <text>]]>
  </DemoCard>
  <turbo-frame id="details" />
  <turbo-cable-stream-source channel="DemoChannel" />
</Gallery>`

describe("Expo Turbo XML tree", () => {
  test("preserves mixed content, namespaces, comments, CDATA, stable ids, and indexes", () => {
    const tree = parseExpoTurboDocument(documentXml, { url: "https://example.test/demo" })
    const alpha = tree.getElementById("alpha")
    const text = alpha?.children.find((node) => isElement(node) && node.tagName === "DemoText")
    const emphasis = text && isElement(text) ? text.children.find(isElement) : undefined

    expect(tree.document.url).toBe("https://example.test/demo")
    expect(alpha?.key).toBe("id:alpha")
    expect(text && isElement(text) ? text.children.map((node) => node.kind) : []).toEqual([
      "text",
      "element",
      "text",
    ])
    expect(text ? nodeTextContent(text) : undefined).toBe("Hello world!")
    expect(text ? renderedNodeTextContent(text) : undefined).toBe("Hello world!")
    expect(emphasis?.namespaceUri).toBe("urn:expo-turbo:demo")
    expect(tree.getFrames().map((frame) => attributeValue(frame, "id"))).toEqual(["details"])
    expect(tree.getStreamSources()).toHaveLength(1)
    expect(alpha?.children.some((node) => node.kind === "comment")).toBe(true)
    expect(alpha?.children.some((node) => node.kind === "text" && node.cdata)).toBe(true)
  })

  test("queries the case-sensitive mutable tree without stale selector results", () => {
    const tree = parseExpoTurboDocument(documentXml)
    const details = tree.getElementById("details")
    if (!details) throw new Error("fixture lost the details frame")

    expect(querySelectorAll(tree, "DemoCard.featured, turbo-frame#details")).toHaveLength(2)
    expect(querySelectorAll(tree, "democard")).toHaveLength(0)
    expect(querySelectorAll(tree, '[data-state="ready"]')).toHaveLength(1)
    expect(querySelectorAll(tree, "Gallery > DemoCard:first-child")).toHaveLength(1)
    expect(querySelectorAll(tree, "DemoCard + turbo-frame")).toHaveLength(1)
    expect(querySelectorAll(tree, "turbo-frame:nth-child(2)")).toHaveLength(1)
    tree.setAttribute(details, "data-state", "ready")
    expect(querySelectorAll(tree, '[data-state="ready"]')).toHaveLength(2)
    expect(() => querySelectorAll(tree, "DemoCard[")).toThrow(TargetError)
    expect(() => querySelectorAll(tree, "demo|DemoCard")).toThrow(TargetError)
  })

  test("normalizes default text while inheriting and resetting xml:space", () => {
    const tree = parseExpoTurboDocument(`<Gallery xml:space="preserve">
      <DemoText id="preserved">  keep\n  this  </DemoText>
      <DemoText id="default" xml:space="default">  collapse\n  this  </DemoText>
      <DemoText id="empty" xml:space="default">\n    </DemoText>
      <DemoText id="cdata" xml:space="default"><![CDATA[  raw\n  text  ]]></DemoText>
    </Gallery>`)
    const preserved = tree.getElementById("preserved")
    const defaultText = tree.getElementById("default")
    const empty = tree.getElementById("empty")
    const cdata = tree.getElementById("cdata")
    if (!preserved || !defaultText || !empty || !cdata) {
      throw new Error("fixture lost a text element")
    }

    expect(renderedNodeTextContent(preserved)).toBe("  keep\n  this  ")
    expect(renderedNodeTextContent(defaultText)).toBe("collapse this")
    expect(renderedNodeTextContent(empty)).toBe("")
    expect(renderedNodeTextContent(cdata)).toBe("  raw\n  text  ")
  })

  test("deep-clones active trees without sharing nodes or reusing mutation keys", () => {
    const tree = parseExpoTurboDocument("<Gallery><DemoText>One</DemoText></Gallery>", {
      url: "https://example.test/gallery",
    })
    const root = tree.document.children.find(isElement)
    const source = root?.children.find(isElement)
    if (!root || !source) throw new Error("fixture lost its root or source")
    tree.insertClones(root, root.children.length, [source])

    const clone = tree.clone()
    const clonedRoot = clone.document.children.find(isElement)
    const clonedMutation = clone.getNodeByKey("mutation:0")
    const originalMutation = tree.getNodeByKey("mutation:0")
    if (!clonedRoot || !clonedMutation || !originalMutation || !isElement(clonedMutation)) {
      throw new Error("clone lost its mutation fixture")
    }

    expect(clone.document).not.toBe(tree.document)
    expect(clone.document.url).toBe(tree.document.url)
    expect(clonedMutation).not.toBe(originalMutation)
    expect(clonedMutation.parent).not.toBe(originalMutation.parent)
    clone.setAttribute(clonedMutation, "data-state", "changed")
    expect(attributeValue(clonedMutation, "data-state")).toBe("changed")
    expect(
      isElement(originalMutation) ? attributeValue(originalMutation, "data-state") : undefined,
    ).toBeUndefined()

    clone.insertClones(clonedRoot, clonedRoot.children.length, [source])
    expect(clone.getNodeByKey("mutation:2")).toBeDefined()
    expect(tree.getNodeByKey("mutation:2")).toBeUndefined()

    const retargeted = tree.clone({ documentUrl: "https://example.test/restored#history" })
    expect(retargeted.document.url).toBe("https://example.test/restored#history")
    expect(tree.document.url).toBe("https://example.test/gallery")
    expect(() => tree.clone({ documentUrl: "" })).toThrow(TargetError)
  })

  test("parses ordered multi-root Turbo Stream fragments behind a private wrapper", () => {
    const tree = parseTurboStreamFragment(`
      <turbo-stream action="append" target="items"><template><DemoText id="one" /></template></turbo-stream>
      <turbo-stream action="remove" target="stale"></turbo-stream>
    `)
    const streams = tree.document.children.filter(isElement)

    expect(streams.map((stream) => attributeValue(stream, "action"))).toEqual(["append", "remove"])
    expect(streams.every((stream) => stream.kind === "stream")).toBe(true)
    expect(tree.getElementById("one")?.tagName).toBe("DemoText")
  })

  test.each([
    ["DOCTYPE", '<!DOCTYPE Gallery SYSTEM "https://invalid.example/test.dtd"><Gallery />'],
    ["processing instruction", "<Gallery><?target unsafe?></Gallery>"],
    ["non-UTF-8 declaration", '<?xml version="1.0" encoding="ISO-8859-1"?><Gallery />'],
    ["undeclared prefix", "<demo:Gallery />"],
    ["invalid xml:space", '<Gallery xml:space="invalid" />'],
    ["empty xml:space", '<Gallery xml:space="" />'],
    ["blank id", '<Gallery><DemoText id="" /></Gallery>'],
    ["duplicate id", '<Gallery><DemoText id="same"/><DemoText id="same"/></Gallery>'],
  ])("rejects %s before admitting a document", (_name, xml) => {
    expect(() => parseExpoTurboDocument(xml)).toThrow(ParseError)
  })

  test("enforces structural limits and fragment rules", () => {
    expect(
      parseExpoTurboDocument(
        '<?xml version="1.0" encoding="UTF-8"?><Gallery />',
      ).document.children.filter(isElement),
    ).toHaveLength(1)
    expect(() =>
      parseExpoTurboDocument("<one><two><three /></two></one>", { limits: { maxDepth: 2 } }),
    ).toThrow(/depth limit/)
    expect(() =>
      parseExpoTurboDocument('<DemoText first="1" second="2" />', {
        limits: { maxAttributesPerElement: 1 },
      }),
    ).toThrow(/attribute limit/)
    expect(() => parseTurboStreamFragment('<?xml version="1.0"?><turbo-stream />')).toThrow(
      /declarations are not allowed in fragments/,
    )
    expect(() => parseTurboStreamFragment("<DemoText />")).toThrow(
      /only turbo-stream root elements/,
    )
  })
})
