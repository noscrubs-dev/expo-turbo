import {
  BeforePrefetchEvent,
  DOCUMENT_VISIT_LIFECYCLE_BEFORE_PREFETCH_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH,
  type DocumentVisitLifecycle,
  LinkClickEvent,
} from "./document-visit-lifecycle.js"

const controllerLifecycles = new WeakMap<object, DocumentVisitLifecycle | undefined>()

export function registerDocumentVisitControllerLifecycle(
  controller: object,
  lifecycle: DocumentVisitLifecycle | undefined,
): void {
  controllerLifecycles.set(controller, lifecycle)
}

export function dispatchDocumentVisitLinkClick(
  controller: object,
  nodeKey: string,
  url: string,
): boolean {
  const event = controllerLifecycles
    .get(controller)
    ?.[DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH](new LinkClickEvent(nodeKey, url))
  return event?.defaultPrevented !== true
}

export function dispatchDocumentVisitBeforePrefetch(
  controller: object | undefined,
  nodeKey: string,
  url: string,
): boolean {
  const lifecycle = controller ? controllerLifecycles.get(controller) : undefined
  const event = lifecycle?.[DOCUMENT_VISIT_LIFECYCLE_BEFORE_PREFETCH_DISPATCH](
    new BeforePrefetchEvent(nodeKey, url),
  )
  return event?.defaultPrevented !== true
}
