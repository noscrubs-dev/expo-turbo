import {
  DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH,
  type DocumentVisitLifecycle,
  LinkClickEvent,
} from "./document-visit-lifecycle"

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
