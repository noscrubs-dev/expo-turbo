import type { DocumentRenderMethod } from "./document-visit-lifecycle"

export type DocumentRefreshScrollPolicy = "preserve" | "reset"

interface DocumentLoadRenderOptions {
  readonly refreshScroll: DocumentRefreshScrollPolicy | undefined
  refreshScrollReady: boolean
  readonly renderMethod: DocumentRenderMethod
}

const documentLoadRenderOptions = new WeakMap<object, DocumentLoadRenderOptions>()

/** @internal Captures a controller-selected document render mode without widening DocumentLoadOptions. */
export function withDocumentLoadRenderMethod<Options extends object>(
  options: Options,
  renderMethod: DocumentRenderMethod,
  refreshScroll?: DocumentRefreshScrollPolicy,
): Options {
  documentLoadRenderOptions.set(options, { refreshScroll, refreshScrollReady: false, renderMethod })
  return options
}

/** @internal Reads the mode captured by the trusted document visit controller. */
export function documentLoadRenderMethod(options: object): DocumentRenderMethod {
  return documentLoadRenderOptions.get(options)?.renderMethod ?? "replace"
}

/** @internal Permits a reset only after the visit controller owns a live renderer ticket. */
export function enableDocumentLoadRefreshScroll(options: object): void {
  const render = documentLoadRenderOptions.get(options)
  if (render?.refreshScroll === "reset") render.refreshScrollReady = true
}

/** @internal Reads the trusted refresh scroll policy once its renderer ticket is live. */
export function documentLoadRefreshScroll(
  options: object,
): DocumentRefreshScrollPolicy | undefined {
  const render = documentLoadRenderOptions.get(options)
  return render?.refreshScrollReady ? render.refreshScroll : undefined
}
