import { describe, expect, test } from "bun:test"
import { DOMParser } from "@xmldom/xmldom"
import { XMLParser, XMLValidator } from "fast-xml-parser"

const representativeXml = `
<DemoCard xmlns:demo="urn:expo-turbo:demo" id="card-1">
  <DemoText>Hello <demo:Emphasis>world</demo:Emphasis>!</DemoText>
  <!-- inspector-only note -->
  <![CDATA[raw <text>]]>
</DemoCard>
`.trim()

function parseStrictDom(xml: string) {
  return new DOMParser({
    locator: true,
    onError(level, message) {
      throw new Error(`${level}: ${message}`)
    },
  }).parseFromString(xml, "application/xml")
}

function validateFastXml(xml: string) {
  return XMLValidator.validate(xml)
}

describe("XML parser candidates", () => {
  test("both retain representative mixed-content order", () => {
    const dom = parseStrictDom(representativeXml)
    const text = dom.getElementsByTagName("DemoText")[0]
    const emphasis = dom.getElementsByTagNameNS("urn:expo-turbo:demo", "Emphasis")[0]

    expect(text?.childNodes.length).toBe(3)
    expect(text?.childNodes[0]?.nodeValue).toBe("Hello ")
    expect(text?.childNodes[1]?.nodeName).toBe("demo:Emphasis")
    expect(text?.childNodes[2]?.nodeValue).toBe("!")
    expect(emphasis?.namespaceURI).toBe("urn:expo-turbo:demo")

    const ordered = new XMLParser({
      captureMetaData: true,
      cdataPropName: "#cdata",
      commentPropName: "#comment",
      ignoreAttributes: false,
      parseTagValue: false,
      preserveOrder: true,
      processEntities: false,
      trimValues: false,
    }).parse(representativeXml) as Array<Record<string, unknown>>

    expect(ordered).toHaveLength(1)
    expect(JSON.stringify(ordered)).toContain('"#text":"Hello "')
    expect(JSON.stringify(ordered)).toContain('"demo:Emphasis"')
    expect(JSON.stringify(ordered)).toContain('"#comment"')
    expect(JSON.stringify(ordered)).toContain('"#cdata"')
  })

  test("xmldom supplies the mutable, namespace-aware tree operations the runtime needs", () => {
    const dom = parseStrictDom(representativeXml)
    const root = dom.documentElement
    const text = dom.getElementsByTagName("DemoText")[0]
    if (!root) throw new Error("representative fixture lost its document root")
    if (!text) throw new Error("representative fixture lost DemoText")

    const clone = text.cloneNode(true)
    root.appendChild(clone)
    expect(root.lastChild?.textContent).toBe("Hello world!")

    const replacement = dom.createElement("DemoText")
    replacement.setAttribute("id", "replacement")
    root.replaceChild(replacement, clone)
    expect(root.lastChild).toBe(replacement)
    expect(replacement.getAttribute("id")).toBe("replacement")
  })

  test.each([
    ["mismatched tags", "<DemoCard><DemoText></DemoCard>"],
    ["duplicate attributes", '<DemoCard id="one" id="two" />'],
  ])("both reject %s with actionable parser context", (_name, xml) => {
    expect(validateFastXml(xml)).not.toBe(true)
    expect(() => parseStrictDom(xml)).toThrow()
  })

  test("the comparison records where a protocol preflight remains mandatory", () => {
    expect(validateFastXml("<demo:Card />")).toBe(true)
    expect(() => parseStrictDom("<demo:Card />")).toThrow(/NamespaceError/)

    const doctype = '<!DOCTYPE DemoCard SYSTEM "https://invalid.example/test.dtd"><DemoCard />'
    expect(validateFastXml(doctype)).toBe(true)
    expect(parseStrictDom(doctype).doctype?.name).toBe("DemoCard")
  })

  test("fast-xml-parser can stop excessive nesting before completing its object tree", () => {
    const parser = new XMLParser({ maxNestedTags: 1, preserveOrder: true })
    expect(() => parser.parse("<one><two><three></three></two></one>")).toThrow(
      "Maximum nested tags exceeded",
    )
  })
})
