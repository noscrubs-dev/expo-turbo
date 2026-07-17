import type { ExpoTurboErrorCode, ExpoTurboErrorContext } from "./errors"

export interface InspectorRequest {
  readonly id: string
  readonly kind: "document" | "frame" | "stream"
  readonly method: string
  readonly state: "pending" | "completed" | "failed" | "canceled"
  readonly url: string
}

export interface InspectorSubscription {
  readonly identifier: string
  readonly state: "connecting" | "connected" | "reconnecting" | "rejected" | "disconnected"
}

export interface InspectorAction {
  readonly action: string
  readonly source: "cable" | "document" | "frame" | "http"
  readonly target?: string
}

export interface InspectorError {
  readonly code: ExpoTurboErrorCode
  readonly context: Readonly<ExpoTurboErrorContext>
  readonly message: string
}

export interface ProtocolInspectorSnapshot {
  readonly actions: readonly InspectorAction[]
  readonly documentUrl?: string
  readonly errors: readonly InspectorError[]
  readonly frameIds: readonly string[]
  readonly requests: readonly InspectorRequest[]
  readonly revision: number
  readonly subscriptions: readonly InspectorSubscription[]
}

export type ProtocolInspectorUpdate = Partial<Omit<ProtocolInspectorSnapshot, "revision">>

export interface ProtocolInspectorAdapter {
  publish(snapshot: ProtocolInspectorSnapshot): void
}

export interface ProtocolInspector {
  getSnapshot(): ProtocolInspectorSnapshot
  update(update: ProtocolInspectorUpdate): ProtocolInspectorSnapshot
}

const EMPTY_SNAPSHOT: ProtocolInspectorSnapshot = Object.freeze({
  actions: Object.freeze([]),
  errors: Object.freeze([]),
  frameIds: Object.freeze([]),
  requests: Object.freeze([]),
  revision: 0,
  subscriptions: Object.freeze([]),
})

function freezeSnapshot(snapshot: ProtocolInspectorSnapshot): ProtocolInspectorSnapshot {
  return Object.freeze({
    ...snapshot,
    actions: Object.freeze(snapshot.actions.map((action) => Object.freeze({ ...action }))),
    errors: Object.freeze(
      snapshot.errors.map((error) =>
        Object.freeze({ ...error, context: Object.freeze({ ...error.context }) }),
      ),
    ),
    frameIds: Object.freeze([...snapshot.frameIds]),
    requests: Object.freeze(snapshot.requests.map((request) => Object.freeze({ ...request }))),
    subscriptions: Object.freeze(
      snapshot.subscriptions.map((subscription) => Object.freeze({ ...subscription })),
    ),
  })
}

export function createProtocolInspector(adapter?: ProtocolInspectorAdapter): ProtocolInspector {
  let snapshot = EMPTY_SNAPSHOT

  return {
    getSnapshot() {
      return snapshot
    },
    update(update) {
      snapshot = freezeSnapshot({ ...snapshot, ...update, revision: snapshot.revision + 1 })
      adapter?.publish(snapshot)
      return snapshot
    },
  }
}
