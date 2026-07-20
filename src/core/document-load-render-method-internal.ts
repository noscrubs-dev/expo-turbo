import type { DocumentRenderMethod } from "./document-visit-lifecycle"

const documentLoadRenderMethods = new WeakMap<object, DocumentRenderMethod>()

/** @internal Captures a controller-selected document render mode without widening DocumentLoadOptions. */
export function withDocumentLoadRenderMethod<Options extends object>(
  options: Options,
  renderMethod: DocumentRenderMethod,
): Options {
  documentLoadRenderMethods.set(options, renderMethod)
  return options
}

/** @internal Reads the mode captured by the trusted document visit controller. */
export function documentLoadRenderMethod(options: object): DocumentRenderMethod {
  return documentLoadRenderMethods.get(options) ?? "replace"
}
