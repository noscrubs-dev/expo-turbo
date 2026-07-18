import type { DocumentHistoryEntry } from "./document-history"
import type {
  DocumentTraversalRestoreResult,
  DocumentVisitController,
} from "./document-visit-controller"
import { StateError } from "./errors"

export interface DocumentHistoryTraversalSource {
  subscribe(listener: (entry: DocumentHistoryEntry) => void): DocumentHistoryTraversalUnsubscribe
}

export type DocumentHistoryTraversalUnsubscribe = () => undefined

export interface DocumentHistoryTraversalSubscriptionOptions {
  readonly onError: (error: Error) => void
  readonly onResult?: (result: DocumentTraversalRestoreResult) => void
}

function observerFailure(error: unknown): Error {
  return error instanceof Error
    ? error
    : new StateError("Document history traversal observer failed")
}

function throwObserverFailure(error: unknown): void {
  queueMicrotask(() => {
    throw observerFailure(error)
  })
}

/**
 * Connects managed host history entries to the document restoration path.
 * The host remains responsible for translating router/pop events into entries.
 */
export function subscribeDocumentHistoryTraversal(
  source: DocumentHistoryTraversalSource,
  controller: Pick<DocumentVisitController, "restoreTraversal">,
  options: DocumentHistoryTraversalSubscriptionOptions,
): DocumentHistoryTraversalUnsubscribe {
  let active = true
  let epoch = 0

  const receive = (entry: DocumentHistoryEntry): void => {
    if (!active) return
    const eventEpoch = ++epoch
    let restoration: Promise<DocumentTraversalRestoreResult>
    try {
      restoration = controller.restoreTraversal(entry)
    } catch (error) {
      restoration = Promise.reject(error)
    }
    void restoration.then(
      (result) => {
        if (!active || eventEpoch !== epoch || !options.onResult) return
        try {
          options.onResult(result)
        } catch (error) {
          throwObserverFailure(error)
        }
      },
      (error: unknown) => {
        if (!active || eventEpoch !== epoch) return
        const reported =
          error instanceof Error ? error : new StateError("Document history traversal failed")
        try {
          options.onError(reported)
        } catch (observerError) {
          queueMicrotask(() => {
            throw new AggregateError(
              [reported, observerFailure(observerError)],
              "Document history traversal error observer failed",
            )
          })
        }
      },
    )
  }

  let unsubscribe: unknown
  try {
    unsubscribe = source.subscribe(receive)
  } catch {
    active = false
    epoch += 1
    throw new StateError("Document history traversal subscription failed")
  }
  if (typeof unsubscribe !== "function") {
    active = false
    epoch += 1
    if (typeof unsubscribe === "object" && unsubscribe !== null) {
      void Promise.resolve(unsubscribe).catch(() => undefined)
    }
    throw new StateError("Document history traversal source must return an unsubscribe function")
  }

  let subscribed = true
  return () => {
    if (!subscribed) return undefined
    subscribed = false
    active = false
    epoch += 1
    let cleanupResult: unknown
    try {
      cleanupResult = unsubscribe()
    } catch {
      throw new StateError("Document history traversal unsubscribe failed")
    }
    if (cleanupResult !== undefined) {
      if (
        (typeof cleanupResult === "object" && cleanupResult !== null) ||
        typeof cleanupResult === "function"
      ) {
        void Promise.resolve(cleanupResult).catch(() => undefined)
      }
      throw new StateError("Document history traversal unsubscribe failed")
    }
    return undefined
  }
}
