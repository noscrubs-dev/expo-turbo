import type {
  BeforeDocumentRenderEventDetail,
  DocumentMorphEventDetail,
  DocumentRenderMethod,
} from "./document-visit-lifecycle"

export type DocumentRefreshScrollPolicy = "preserve" | "reset"

interface DocumentLoadRenderOptions {
  readonly afterMorph: ((detail: DocumentMorphEventDetail) => void) | undefined
  readonly beforeRender:
    | ((detail: Omit<BeforeDocumentRenderEventDetail, "render">) => boolean | PromiseLike<boolean>)
    | undefined
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
  afterMorph?: (detail: DocumentMorphEventDetail) => void,
  beforeRender?: (
    detail: Omit<BeforeDocumentRenderEventDetail, "render">,
  ) => boolean | PromiseLike<boolean>,
): Options {
  documentLoadRenderOptions.set(options, {
    afterMorph,
    beforeRender,
    refreshScroll,
    refreshScrollReady: false,
    renderMethod,
  })
  return options
}

/** @internal Runs the trusted visit lifecycle's pre-mutation document render admission. */
export function documentLoadBeforeRender(
  options: object,
  detail: Omit<BeforeDocumentRenderEventDetail, "render">,
): boolean | PromiseLike<boolean> {
  return documentLoadRenderOptions.get(options)?.beforeRender?.(detail) ?? true
}

/** @internal Reads the mode captured by the trusted document visit controller. */
export function documentLoadRenderMethod(options: object): DocumentRenderMethod {
  return documentLoadRenderOptions.get(options)?.renderMethod ?? "replace"
}

/** @internal Notifies the trusted visit lifecycle after a successful logical page morph. */
export function notifyDocumentLoadMorph(options: object, detail: DocumentMorphEventDetail): void {
  documentLoadRenderOptions.get(options)?.afterMorph?.(detail)
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
