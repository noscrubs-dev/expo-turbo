import { DOMParser } from "@xmldom/xmldom"
import { selectAll } from "css-select"
import { XMLParser } from "fast-xml-parser"

const probeXml = "<ParserProbe />"

const domName = new DOMParser().parseFromString(probeXml, "application/xml").documentElement
  ?.nodeName

const ordered = new XMLParser({ preserveOrder: true }).parse(probeXml) as Record<
  string,
  unknown
>[]
const orderedName = Object.keys(ordered[0] ?? {})[0]

export const PARSER_CANDIDATE_SMOKE = `${domName}/${orderedName}`
export const SELECTOR_CANDIDATE_SMOKE = typeof selectAll === "function" ? "css-select" : "unavailable"
