import type {
  CableAdapter,
  ClockAdapter,
  DocumentHistoryHostAdapter,
  FetchAdapter,
  FocusAdapter,
  NavigationAdapter,
  RequestIdAdapter,
} from "../adapters/index.js"
import {
  type ExactFormSubmissionActivity,
  formSubmissionActivity,
} from "../core/form-submission-activity.js"
import {
  CableStreamSourceRegistry,
  DocumentFormControls,
  DocumentHistory,
  DocumentRefreshController,
  DocumentRequestLoader,
  DocumentSession,
  DocumentSnapshotCache,
  DocumentStateScopes,
  DocumentStateStore,
  DocumentVisitController,
  DocumentVisitLifecycle,
  type DocumentVisitResult,
  FormLinkSubmissionController,
  type FormLinkSubmissionControllerOptions,
  FormSubmissionController,
  type FormSubmissionControllerSubmitOptions,
  type FormSubmissionReport,
  FrameControllerRegistry,
  FrameHistoryCoordinator,
  FrameRequestLoader,
  isElement,
  parseExpoTurboDocument,
  StateError,
} from "../core/index.js"
import { serializeClientDescriptor } from "../core/protocol-request.js"
import type { ComponentRegistry, RegistryComponent } from "../registry/index.js"

const clock: ClockAdapter = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
}

/** Matches the core controllers' own fallback when no observer was supplied. */
function rethrowUnobserved(error: Error): void {
  queueMicrotask(() => {
    throw error
  })
}

const PLACEHOLDER_DOCUMENT =
  '<turbo-frame id="expo-turbo-placeholder" disabled="" data-turbo-cache-control="no-cache" />'

/**
 * The generated form-link controller a runtime builds for itself, plus the
 * disposal the base controller does not have.
 *
 * A form submission keeps its abort controller inside the submitting node's
 * activity, and the base class records no activity of its own. The only handle
 * on an in-flight generated form-link request is therefore the one whoever
 * constructed the controller keeps. Without it, unmount leaves the request
 * running and its response commits into a session nobody renders any more:
 * the document URL moves under a disposed runtime.
 *
 * A host that builds its own controller and passes it to `ExpoTurboProvider`
 * keeps the plain base class. The runtime disposes only what the runtime made.
 */
export class ExpoTurboFormLinkSubmissions extends FormLinkSubmissionController {
  private readonly active = new Map<ExactFormSubmissionActivity, number>()
  private disposed = false

  constructor(
    private readonly linkSession: DocumentSession,
    submissionController: Pick<FormSubmissionController, "submit">,
    requestIds: RequestIdAdapter,
    options: FormLinkSubmissionControllerOptions = {},
  ) {
    super(linkSession, submissionController, requestIds, options)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Aborts every generated form-link request this controller still has in
   * flight. Idempotent: the runtime calls it once, and a second call has
   * nothing left to cancel.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const activity of [...this.active.keys()]) {
      this.active.delete(activity)
      activity.cancelActive()
    }
  }

  submit(
    linkNodeKey: string,
    href: string,
    options: FormSubmissionControllerSubmitOptions = {},
  ): Promise<FormSubmissionReport> {
    // Refusing after disposal closes the other half of the same hole: an
    // activation that starts late would commit into the disposed session just
    // as surely as one that was already running.
    if (this.disposed) {
      throw new StateError("Generated form links have been disposed", { target: linkNodeKey })
    }
    const activity = this.activityFor(linkNodeKey)
    if (!activity) return super.submit(linkNodeKey, href, options)
    this.retain(activity)
    return super.submit(linkNodeKey, href, options).finally(() => this.release(activity))
  }

  /**
   * The activity is keyed on the exact link node, which is what the base
   * controller hands the submission as the proposal's activity owner.
   */
  private activityFor(linkNodeKey: string): ExactFormSubmissionActivity | undefined {
    if (typeof linkNodeKey !== "string" || linkNodeKey === "") return undefined
    const link = this.linkSession.tree.getNodeByKey(linkNodeKey)
    if (!link || !isElement(link) || !this.linkSession.tree.contains(link)) return undefined
    return formSubmissionActivity(this.linkSession, link)
  }

  /**
   * Counted, not a set membership: one link can supersede its own submission,
   * and the superseded attempt settles while the replacement is still running.
   */
  private retain(activity: ExactFormSubmissionActivity): void {
    this.active.set(activity, (this.active.get(activity) ?? 0) + 1)
  }

  private release(activity: ExactFormSubmissionActivity): void {
    const remaining = (this.active.get(activity) ?? 0) - 1
    if (remaining > 0) this.active.set(activity, remaining)
    else this.active.delete(activity)
  }
}

export interface ExpoTurboRuntime {
  readonly controller: DocumentVisitController
  /**
   * Turbo's temporary-form path for links carrying `data-turbo-method` or
   * `data-turbo-stream` — the ordinary Rails delete-button idiom. The runtime
   * builds it because it is the only party holding both the submission
   * controller and the registry the controller needs to read link vocabulary.
   * Having built it, the runtime also owns its disposal.
   */
  readonly formLinks: ExpoTurboFormLinkSubmissions
  readonly forms: DocumentFormControls
  readonly frames: FrameControllerRegistry
  readonly scopes: DocumentStateScopes
  readonly session: DocumentSession
  readonly state: DocumentStateStore
  /** Present only when a Cable adapter was supplied. */
  readonly streamSources?: CableStreamSourceRegistry
  dispose(): void
  load(): Promise<DocumentVisitResult>
}

export interface CreateExpoTurboRuntimeOptions {
  /**
   * Transport for `turbo-cable-stream-source` elements. Supplying it is what
   * creates the Stream source registry; the runtime owns its disposal.
   */
  readonly cable?: CableAdapter
  readonly fetch: FetchAdapter
  /**
   * Logical focus for form validation. The runtime is the single owner: it
   * hands this one adapter to every consumer that needs it, so a host never
   * has to pass the same object to two places and keep their lifetimes in step.
   */
  readonly focus?: FocusAdapter
  readonly history?: DocumentHistoryHostAdapter
  readonly navigation?: NavigationAdapter
  /**
   * Receives faults from background work: Cable subscription and dispatch, and
   * document refresh. These are not document faults, so they are reported
   * rather than replacing the mounted document with an error surface — but they
   * must be reported, because the alternative is an uncaught microtask throw
   * the host can neither see nor catch.
   */
  readonly onBackgroundError?: (error: Error) => void
  readonly registry: ComponentRegistry<RegistryComponent>
  readonly url: string
}

export function createExpoTurboRuntime(options: CreateExpoTurboRuntimeOptions): ExpoTurboRuntime {
  let requestId = 0
  const requestIds = {
    next: () => `expo-turbo-${++requestId}`,
  }
  const session = new DocumentSession(
    parseExpoTurboDocument(PLACEHOLDER_DOCUMENT, { url: options.url }),
  )
  const state = new DocumentStateStore()
  const scopes = new DocumentStateScopes(session)
  const visitLifecycle = new DocumentVisitLifecycle()
  const snapshots = new DocumentSnapshotCache()
  const history = options.history
    ? new DocumentHistory({ next: () => `expo-turbo-history-${++requestId}` }, options.history)
    : undefined
  history?.initialize({ kind: "unmanaged", url: options.url })
  const clientDescriptor = serializeClientDescriptor(options.registry.capabilities.hash)
  const loader = new DocumentRequestLoader(session, options.fetch, requestIds, {
    clientDescriptor,
  })
  const controller = new DocumentVisitController(loader, clock, {
    ...(history ? { history } : {}),
    snapshotCache: snapshots,
    visitLifecycle,
  })
  const onBackgroundError = options.onBackgroundError
  // Spread rather than a wrapper: an always-present callback would replace each
  // controller's own fallback reporting with a no-op when the host supplied
  // nothing, which is worse than the default it displaced.
  const backgroundErrorOption = onBackgroundError ? { onError: onBackgroundError } : {}
  const refresh = new DocumentRefreshController(session, controller, clock, backgroundErrorOption)
  const frameHistory = history
    ? new FrameHistoryCoordinator(session, {
        history,
        ...(options.navigation ? { navigation: options.navigation } : {}),
        snapshotCache: snapshots,
        visitLifecycle,
      })
    : undefined
  const frames = new FrameControllerRegistry(
    session,
    new FrameRequestLoader(session, options.fetch, requestIds, {
      clientDescriptor,
      refresh,
    }),
    undefined,
    options.navigation,
    controller,
    frameHistory ? { frameHistory } : undefined,
  )
  const submission = new FormSubmissionController(session, options.fetch, {
    frameControllers: frames,
    ...(history ? { history } : {}),
    ...(options.navigation ? { navigation: options.navigation } : {}),
    refresh,
    snapshotCache: snapshots,
    visitLifecycle,
  })
  const forms = new DocumentFormControls(session, {
    ...(options.focus ? { focus: options.focus } : {}),
    formSemantics: options.registry,
    moduleVersions: clientDescriptor,
    submissionController: submission,
  })
  // `data-turbo-method` on a link is the ordinary Rails delete-button idiom, so
  // a server rendering standard Turbo markup expects a client that can act on
  // it. The registry has to arrive with the controller: since #427 this one
  // fails closed without `formSemantics`, so constructing it bare would trade a
  // loud refusal for a silent one. The runtime holds the registry already,
  // which is exactly why the host never has to hand one over.
  const formLinks = new ExpoTurboFormLinkSubmissions(session, submission, requestIds, {
    formSemantics: options.registry,
    moduleVersions: clientDescriptor,
  })
  // Cable delivers Stream actions, including `refresh`, for as long as the
  // socket is up. It does NOT recover the document after a reconnect: a
  // broadcast missed while the socket was down leaves the mounted document
  // stale until something else refreshes it. That is a known limitation rather
  // than an oversight — it matches the behavior before `cable` existed — and
  // `runtime.test.ts` pins it. Recovery is tracked in
  // https://github.com/noscrubs-dev/expo-turbo/pull/418.
  const streamSources = options.cable
    ? new CableStreamSourceRegistry(session, options.cable, {
        // This registry requires an observer, so the fallback has to be the
        // loud one rather than a no-op that swallows the fault.
        onError: onBackgroundError ?? rethrowUnobserved,
        streamOptions: { refresh },
      })
    : undefined
  let disposed = false

  return Object.freeze({
    controller,
    formLinks,
    forms,
    frames,
    scopes,
    session,
    state,
    ...(streamSources ? { streamSources } : {}),
    dispose(): void {
      if (disposed) return
      disposed = true
      // Before the rest of the teardown: an aborted request settles as
      // canceled, so nothing downstream is asked to apply a response into
      // controllers that are about to go away.
      formLinks.dispose()
      forms.dispose()
      frames.dispose()
      streamSources?.dispose()
      refresh.dispose()
      controller.cancel()
      loader.cancel()
      scopes.dispose()
      state.dispose()
    },
    load(): Promise<DocumentVisitResult> {
      return controller.visit(options.url)
    },
  })
}
