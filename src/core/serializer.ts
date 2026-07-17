import type { DocumentTree, ProtocolAttribute, ProtocolNode } from "./tree"

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function serializeAttribute(attribute: ProtocolAttribute): string {
  return `${attribute.name}="${escapeAttribute(attribute.value)}"`
}

function serializeNode(node: ProtocolNode): string {
  if (node.kind === "comment") return `<!--${node.value}-->`
  if (node.kind === "text") {
    return node.cdata ? `<![CDATA[${node.value}]]>` : escapeText(node.value)
  }
  if (node.kind === "document") return node.children.map(serializeNode).join("")

  const attributes = [...node.attributes]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(serializeAttribute)
  const opening =
    attributes.length > 0 ? `<${node.tagName} ${attributes.join(" ")}` : `<${node.tagName}`
  if (node.children.length === 0) return `${opening}/>`
  return `${opening}>${node.children.map(serializeNode).join("")}</${node.tagName}>`
}

/** Deterministic fixture/diagnostic output. Production rendering uses the logical tree directly. */
export function serializeExpoTurboTree(tree: DocumentTree): string {
  return serializeNode(tree.document)
}
