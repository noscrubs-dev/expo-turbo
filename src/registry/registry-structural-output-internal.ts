import {
  isElement,
  type ProtocolElement,
  type ProtocolNode,
  renderedTextValue,
} from "../core/tree.js"
import type { ComponentRegistry, RegistryComponent, RegistryVocabularyIssue } from "./registry.js"

export interface RegistryStructuralOutputDiagnostic {
  readonly issues: readonly RegistryVocabularyIssue[]
  readonly node: ProtocolElement
}

export interface RegistryStructuralOutputAnalysis {
  readonly diagnostics: readonly RegistryStructuralOutputDiagnostic[]
  readonly hasOutput: boolean
  readonly hasVocabularyIssues: boolean
}

type StructuralRegistry = Pick<ComponentRegistry<RegistryComponent>, "decodeForRender">

function analyzeNodes(
  registry: StructuralRegistry,
  nodes: readonly ProtocolNode[],
  diagnostics: RegistryStructuralOutputDiagnostic[],
  droppedNodes: ReadonlySet<ProtocolNode> | undefined,
): boolean {
  // Diagnostics are only consumed when nothing renders, so the first renderable
  // node ends the walk.
  for (const node of nodes) {
    if (node.kind === "comment") continue
    if (node.kind === "text") {
      if (renderedTextValue(node) !== "") return true
      continue
    }
    if (node.kind === "document") {
      if (analyzeNodes(registry, node.children, diagnostics, droppedNodes)) return true
      continue
    }
    // A Frame is a runtime-managed content region and a Cable source is a live
    // content feed. Both can produce output after this analysis runs, so they
    // always count. Treating a lazy Frame as blank would unmount the very node
    // that issues its request.
    if (node.kind === "frame" || node.kind === "stream-source") return true
    if (node.kind === "stream" || node.kind === "template") continue
    if (!isElement(node)) continue
    // A node the render path dropped produces no output and renders none of its
    // children, so counting it would make this accounting disagree with the
    // document that was actually committed. Membership is by node identity, so
    // a replacement node is never mistaken for the one that was dropped.
    if (droppedNodes?.has(node)) continue

    try {
      const result = registry.decodeForRender(node)
      if (result.status === "decoded") return true
      if (result.issues.length > 0) {
        diagnostics.push(Object.freeze({ issues: result.issues, node }))
      }
      if (analyzeNodes(registry, result.children, diagnostics, droppedNodes)) return true
    } catch {
      // A non-vocabulary decode failure belongs to the render path, which
      // reports it through the normal error surface.
      return true
    }
  }
  return false
}

export function analyzeRegistryStructuralOutput(
  registry: StructuralRegistry,
  nodes: readonly ProtocolNode[],
  droppedNodes?: ReadonlySet<ProtocolNode>,
): RegistryStructuralOutputAnalysis {
  const diagnostics: RegistryStructuralOutputDiagnostic[] = []
  const hasOutput = analyzeNodes(registry, nodes, diagnostics, droppedNodes)
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    hasOutput,
    hasVocabularyIssues: diagnostics.length > 0,
  })
}
