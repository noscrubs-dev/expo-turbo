import { attributeValue, isElement, type ProtocolNode, type ProtocolParentNode } from "./tree.js"

export function applicationAutofocusCandidatesFromNodes(
  nodes: readonly ProtocolNode[],
): readonly string[] {
  const candidates: string[] = []
  const visit = (node: ProtocolNode) => {
    if (
      !isElement(node) ||
      node.kind === "stream" ||
      node.kind === "stream-source" ||
      node.kind === "template"
    ) {
      return
    }
    const id = node.kind === "element" ? attributeValue(node, "id") : undefined
    if (id && attributeValue(node, "autofocus") !== undefined) candidates.push(node.key)
    for (const child of node.children) visit(child)
  }
  for (const node of nodes) visit(node)
  return Object.freeze(candidates)
}

export function applicationAutofocusCandidates(root: ProtocolParentNode): readonly string[] {
  return applicationAutofocusCandidatesFromNodes(root.children)
}
