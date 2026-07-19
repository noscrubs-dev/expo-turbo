import {
  Component,
  type ComponentType,
  createContext,
  createElement,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react"

import type {
  AutofocusAdapter,
  FormSubmissionAnnouncementAdapter,
  FormSubmissionAnnouncementEvent,
  FormSubmissionAnnouncementTerminalSnapshot,
  NavigationAdapter,
  VisitAction,
} from "../adapters"
import {
  type ComponentStyleLayers,
  resolveComponentStyle,
  type StyleAdapter,
} from "../adapters/styles"
import { wasCableStreamSourceErrorReported } from "../core/cable-stream-source-errors-internal"
import type { CableStreamSourceCollection } from "../core/cable-stream-sources"
import { consumeDocumentAutofocus } from "../core/document-autofocus-internal"
import type {
  DocumentVisitController,
  DocumentVisitDelegation,
  DocumentVisitResult,
  DocumentVisitSnapshot,
} from "../core/document-visit-controller"
import { RegistryError, StateError, TargetError } from "../core/errors"
import type { FormLinkSubmissionController } from "../core/form-link-submission"
import type { FormRequestPlan } from "../core/form-request"
import type {
  FormSubmissionActivitySnapshot,
  FormSubmissionTerminalSnapshot,
  FormSubmitterActivitySnapshot,
} from "../core/form-submission-activity"
import type {
  FormSubmissionControllerSubmitOptions,
  FormSubmissionReport,
} from "../core/form-submission-controller"
import type { FormSubmissionProposal } from "../core/form-submission-proposal"
import type {
  ActiveFormRequestPlanOptions,
  ActiveFormRetryOptions,
  ActiveFormSubmissionProposalOptions,
  ActiveFormSubmissionReport,
  ActiveFormSubmitOptions,
  DocumentFormControls,
  FormConstraintValidationReport,
  FormControlDescriptor,
  FormControlRegistration,
  FormControlRegistry,
  FormControlSelection,
  SuccessfulFormEntriesOptions,
  SuccessfulFormEntry,
} from "../core/forms"
import { consumeFrameAutofocus } from "../core/frame-autofocus-internal"
import type { FrameController, FrameControllerSnapshot } from "../core/frame-controller"
import type { FrameControllerCollection, FrameVisitResult } from "../core/frame-controller-registry"
import { type ExternalDocumentLinkScheme, resolveDocumentLinkUrl } from "../core/protocol-request"
import type { DocumentSession, NodeSnapshot } from "../core/session"
import type {
  DocumentStateScopes,
  DocumentStateStore,
  StateScopeKind,
  StateSnapshot,
} from "../core/state"
import {
  attributeValue,
  isElement,
  type ProtocolDocument,
  type ProtocolElement,
  type ProtocolNode,
  renderedTextValue,
} from "../core/tree"
import { classifyTopLevelLocation } from "../core/visitability"
import type {
  ComponentActionExecutor,
  ComponentActionLifecycle,
  ComponentActionParams,
  ComponentActionResult,
  RegistryComponentAction,
} from "../registry/component-actions"
import type { ComponentRegistry, DecodedComponent, RegistryComponent } from "../registry/registry"

type RenderRegistry = Pick<ComponentRegistry<RegistryComponent>, "decode">

export interface ExpoTurboRenderError {
  readonly error: Error
  readonly nodeKey: string
}

export interface ExpoTurboFrameAccessibilityState {
  readonly busy: boolean
}

export interface ExpoTurboDocumentAccessibilityState {
  readonly busy: boolean
}

export interface ExpoTurboDocumentBinding {
  readonly accessibilityState: ExpoTurboDocumentAccessibilityState
  readonly controller: DocumentVisitController
  readonly state: DocumentVisitSnapshot
}

export interface ExpoTurboDocumentBoundaryProps extends ExpoTurboDocumentBinding {
  readonly children?: ReactNode
}

export interface ExpoTurboFrameBinding {
  readonly accessibilityState: ExpoTurboFrameAccessibilityState
  readonly controller: FrameController
  readonly state: FrameControllerSnapshot
}

export interface ExpoTurboFrameBoundaryProps extends ExpoTurboFrameBinding {
  readonly children?: ReactNode
}

export interface ExpoTurboFormAccessibilityState {
  readonly busy: boolean
}

export interface ExpoTurboFormBinding {
  readonly accessibilityState: ExpoTurboFormAccessibilityState
  cancelSubmission(): void
  checkValidity(): FormConstraintValidationReport
  dismissTerminal(): void
  readonly formNodeKey: string
  readonly requestPlan: (options: ActiveFormRequestPlanOptions) => FormRequestPlan
  readonly shouldInterceptSubmission: (options?: SuccessfulFormEntriesOptions) => boolean
  readonly submissionProposal: (
    options: ActiveFormSubmissionProposalOptions,
  ) => FormSubmissionProposal
  readonly successfulEntries: (
    options?: SuccessfulFormEntriesOptions,
  ) => readonly SuccessfulFormEntry[]
  readonly state: FormSubmissionActivitySnapshot
  readonly terminalState: FormSubmissionTerminalSnapshot
  retryFailure(
    options: ActiveFormRetryOptions,
    controllerOptions?: FormSubmissionControllerSubmitOptions,
  ): Promise<ActiveFormSubmissionReport>
  reportValidity(): FormConstraintValidationReport
  submit(
    options: ActiveFormSubmitOptions,
    controllerOptions?: FormSubmissionControllerSubmitOptions,
  ): Promise<ActiveFormSubmissionReport>
}

export interface ExpoTurboFormBoundaryProps extends ExpoTurboFormBinding {
  readonly children?: ReactNode
}

export interface ExpoTurboFormControlAccessibilityState {
  readonly disabled: boolean
}

export interface ExpoTurboFormControlBinding {
  readonly accessibilityState: ExpoTurboFormControlAccessibilityState
  readonly disabled: boolean
  readonly nodeKey: string
  readonly pending: boolean
  selection(): FormControlSelection
  readonly submitsWith?: string
}

interface ExpoTurboFormContextValue {
  readonly binding: ExpoTurboFormBinding
  readonly registry: FormControlRegistry
}

interface RendererContextValue {
  readonly actions: ComponentActionExecutor | undefined
  readonly autofocus: AutofocusAdapter | undefined
  readonly documentComponent: ComponentType<ExpoTurboDocumentBoundaryProps> | undefined
  readonly documentController: DocumentVisitController | undefined
  readonly frameComponent: ComponentType<ExpoTurboFrameBoundaryProps> | undefined
  readonly formComponent: ComponentType<ExpoTurboFormBoundaryProps> | undefined
  readonly formAnnouncements: FormSubmissionAnnouncementAdapter | undefined
  readonly formLinks: FormLinkSubmissionController | undefined
  readonly frames: FrameControllerCollection | undefined
  readonly forms: DocumentFormControls | undefined
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly registry: RenderRegistry
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
  readonly session: DocumentSession
  readonly scopes: DocumentStateScopes | undefined
  readonly state: DocumentStateStore | undefined
  readonly streamSources: CableStreamSourceCollection | undefined
  readonly styles: StyleAdapter | undefined
}

const RendererContext = createContext<RendererContextValue | undefined>(undefined)
const DocumentContext = createContext<ExpoTurboDocumentBinding | undefined>(undefined)
const FrameContext = createContext<ExpoTurboFrameBinding | undefined>(undefined)
const FormContext = createContext<ExpoTurboFormContextValue | undefined>(undefined)
const NavigationContext = createContext<NavigationAdapter | undefined>(undefined)
const ProtocolNodeContext = createContext<string | undefined>(undefined)
const ComponentTagContext = createContext<string | undefined>(undefined)
const StateScopeContext = createContext<DocumentStateStore | undefined>(undefined)
const providerDisposableOwners = new WeakMap<object, number>()
const announcedFormTerminalRevisions = new WeakMap<
  DocumentSession,
  WeakMap<ProtocolElement, number>
>()
const UNSUPPORTED_DOCUMENT_LINK_ATTRIBUTES = [
  "action",
  "confirm",
  "download",
  "method",
  "stream",
] as const
const MISSING_FORM_OWNER_KEY = "__expo-turbo-missing-form-owner__"

function exactVisitAction(value: string | undefined): VisitAction | undefined {
  return value === "advance" || value === "replace" || value === "restore" ? value : undefined
}

function linkFrameVisitAction(value: string | undefined): VisitAction | null | undefined {
  if (value === undefined) return undefined
  return exactVisitAction(value) ?? null
}

export interface ExpoTurboProviderProps {
  readonly actions?: ComponentActionExecutor
  readonly autofocus?: AutofocusAdapter
  readonly children?: ReactNode
  readonly documentComponent?: ComponentType<ExpoTurboDocumentBoundaryProps>
  readonly documentController?: DocumentVisitController
  readonly frameComponent?: ComponentType<ExpoTurboFrameBoundaryProps>
  readonly formComponent?: ComponentType<ExpoTurboFormBoundaryProps>
  readonly formAnnouncements?: FormSubmissionAnnouncementAdapter
  readonly formLinks?: FormLinkSubmissionController
  readonly frames?: FrameControllerCollection
  readonly forms?: DocumentFormControls
  readonly navigation?: NavigationAdapter
  readonly onError?: (event: ExpoTurboRenderError) => void
  readonly registry: RenderRegistry
  readonly renderError?: (event: ExpoTurboRenderError) => ReactNode
  readonly scopes?: DocumentStateScopes
  readonly session: DocumentSession
  readonly state?: DocumentStateStore
  readonly streamSources?: CableStreamSourceCollection
  readonly styles?: StyleAdapter
}

function useProviderDisposable(resource: Readonly<{ dispose(): void }> | undefined): void {
  useEffect(() => {
    if (!resource) return
    providerDisposableOwners.set(resource, (providerDisposableOwners.get(resource) ?? 0) + 1)
    return () => {
      const owners = providerDisposableOwners.get(resource) ?? 0
      providerDisposableOwners.set(resource, Math.max(0, owners - 1))
      queueMicrotask(() => {
        if (providerDisposableOwners.get(resource) !== 0) return
        providerDisposableOwners.delete(resource)
        resource.dispose()
      })
    }
  }, [resource])
}

export function ExpoTurboProvider(props: ExpoTurboProviderProps): ReactNode {
  useProviderDisposable(props.scopes)
  useProviderDisposable(props.state)
  const value = useMemo<RendererContextValue>(
    () => ({
      actions: props.actions,
      autofocus: props.autofocus,
      documentComponent: props.documentComponent,
      documentController: props.documentController,
      frameComponent: props.frameComponent,
      formComponent: props.formComponent,
      formAnnouncements: props.formAnnouncements,
      formLinks: props.formLinks,
      frames: props.frames,
      forms: props.forms,
      onError: props.onError,
      registry: props.registry,
      renderError: props.renderError,
      scopes: props.scopes,
      session: props.session,
      state: props.state,
      streamSources: props.streamSources,
      styles: props.styles,
    }),
    [
      props.actions,
      props.autofocus,
      props.documentComponent,
      props.documentController,
      props.frameComponent,
      props.formComponent,
      props.formAnnouncements,
      props.formLinks,
      props.frames,
      props.forms,
      props.onError,
      props.registry,
      props.renderError,
      props.scopes,
      props.session,
      props.state,
      props.streamSources,
      props.styles,
    ],
  )
  return createElement(
    RendererContext.Provider,
    { value },
    createElement(NavigationContext.Provider, { value: props.navigation }, props.children),
  )
}

function useRenderer(): RendererContextValue {
  const context = useContext(RendererContext)
  if (!context) throw new RegistryError("Expo Turbo renderer requires ExpoTurboProvider")
  return context
}

export function useProtocolNode(key: string): NodeSnapshot | undefined {
  const { session } = useRenderer()
  const subscribe = useCallback(
    (listener: () => void) => session.subscribe(key, listener),
    [key, session],
  )
  const snapshot = useCallback(() => session.getNodeSnapshot(key), [key, session])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function createComponentStyleHook<TStyle, Token extends string>(
  adapter: StyleAdapter<TStyle, Token>,
): (layers: ComponentStyleLayers<TStyle>) => TStyle {
  return function useBoundComponentStyle(layers: ComponentStyleLayers<TStyle>): TStyle {
    const { session, styles } = useRenderer()
    const nodeKey = useContext(ProtocolNodeContext)
    const component = useContext(ComponentTagContext)
    if (!styles) throw new RegistryError("Expo Turbo component styles require a provider adapter")
    if (styles !== adapter) {
      throw new RegistryError("Expo Turbo component styles require the matching provider adapter")
    }
    if (!nodeKey || !component) {
      throw new RegistryError("Expo Turbo component styles require a component node")
    }
    const node = session.getNodeSnapshot(nodeKey)?.node
    if (!node || !isElement(node)) {
      throw new RegistryError("Expo Turbo component styles require an active component element")
    }
    return resolveComponentStyle(adapter, layers, { component })
  }
}

export function useComponentAction<Definition extends RegistryComponentAction>(
  definition: Definition,
  lifecycle?: ComponentActionLifecycle<ComponentActionResult<Definition>>,
): (params: ComponentActionParams<Definition>) => Promise<ComponentActionResult<Definition>> {
  const { actions } = useRenderer()
  const state = useContext(StateScopeContext)
  if (!actions) throw new RegistryError("Expo Turbo component actions require a provider runner")
  return useCallback(
    (params: ComponentActionParams<Definition>) =>
      actions.executeDefinition(definition, params, lifecycle, state),
    [actions, definition, lifecycle, state],
  )
}

export interface DocumentStateBinding<Value> extends StateSnapshot<Value> {
  remove(): void
  set(value: Value): void
}

function useStateBinding<Value>(
  state: DocumentStateStore,
  key: string,
): DocumentStateBinding<Value> {
  const subscribe = useCallback(
    (listener: () => void) => state.subscribe(key, listener),
    [key, state],
  )
  const getSnapshot = useCallback(() => state.getSnapshot<Value>(key), [key, state])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return useMemo(
    () =>
      Object.freeze({
        ...snapshot,
        remove: () => state.delete(key),
        set: (value: Value) => state.set(key, value),
      }),
    [key, snapshot, state],
  )
}

export function useDocumentState<Value = unknown>(key: string): DocumentStateBinding<Value> {
  const { state } = useRenderer()
  if (!state) throw new RegistryError("Expo Turbo document state requires a provider store")
  return useStateBinding<Value>(state, key)
}

export function useScopedState<Value = unknown>(key: string): DocumentStateBinding<Value> {
  const { state: documentState } = useRenderer()
  const scopedState = useContext(StateScopeContext)
  const state = scopedState ?? documentState
  if (!state) throw new RegistryError("Expo Turbo scoped state requires a provider store")
  return useStateBinding<Value>(state, key)
}

interface StateScopeBoundaryProps {
  readonly children?: ReactNode
  readonly kind: StateScopeKind
  readonly nodeKey: string
  readonly required?: boolean
}

function StateScopeBoundary(props: StateScopeBoundaryProps): ReactNode {
  const { scopes } = useRenderer()
  const scope = useMemo(
    () => scopes?.scopeFor(props.nodeKey, props.kind),
    [props.kind, props.nodeKey, scopes],
  )
  if (props.required && !scopes) {
    throw new RegistryError("Expo Turbo state scopes require a provider scope registry")
  }
  if (!scope) return props.children
  return createElement(StateScopeContext.Provider, { value: scope.state }, props.children)
}

export interface ExpoTurboStateScopeProps {
  readonly children?: ReactNode
  readonly kind: StateScopeKind
}

export function ExpoTurboStateScope(props: ExpoTurboStateScopeProps): ReactNode {
  const nodeKey = useContext(ProtocolNodeContext)
  if (!nodeKey) throw new RegistryError("Expo Turbo state scopes require a component node")
  return createElement(
    StateScopeBoundary,
    {
      kind: props.kind,
      nodeKey,
      required: true,
    },
    props.children,
  )
}

export interface ExpoTurboFormScopeProps {
  readonly children?: ReactNode
}

function useFormBinding(registry: FormControlRegistry, formNodeKey: string): ExpoTurboFormBinding {
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribeSubmission(listener),
    [registry],
  )
  const snapshot = useCallback(() => registry.submissionState, [registry])
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  const subscribeTerminal = useCallback(
    (listener: () => void) => registry.subscribeSubmissionTerminal(listener),
    [registry],
  )
  const terminalSnapshot = useCallback(() => registry.submissionTerminalState, [registry])
  const terminalState = useSyncExternalStore(subscribeTerminal, terminalSnapshot, terminalSnapshot)
  return useMemo<ExpoTurboFormBinding>(
    () =>
      Object.freeze({
        accessibilityState: Object.freeze({ busy: state.busy }),
        cancelSubmission: () => registry.cancelSubmission(),
        checkValidity: () => registry.checkValidity(),
        dismissTerminal: () => registry.dismissSubmissionTerminal(),
        formNodeKey,
        requestPlan: (options: ActiveFormRequestPlanOptions) => registry.requestPlan(options),
        retryFailure: (
          options: ActiveFormRetryOptions,
          controllerOptions?: FormSubmissionControllerSubmitOptions,
        ) => registry.retryFailure(options, controllerOptions),
        reportValidity: () => registry.reportValidity(),
        state,
        shouldInterceptSubmission: (options?: SuccessfulFormEntriesOptions) =>
          registry.shouldInterceptSubmission(options),
        submit: (
          options: ActiveFormSubmitOptions,
          controllerOptions?: FormSubmissionControllerSubmitOptions,
        ) => registry.submit(options, controllerOptions),
        submissionProposal: (options: ActiveFormSubmissionProposalOptions) =>
          registry.submissionProposal(options),
        successfulEntries: (options?: SuccessfulFormEntriesOptions) =>
          registry.successfulEntries(options),
        terminalState,
      }),
    [formNodeKey, registry, state, terminalState],
  )
}

function useResolvedFormRegistry(): Readonly<{
  formNodeKey: string
  registry: FormControlRegistry
}> {
  const { forms, registry: componentRegistry, session } = useRenderer()
  const context = useContext(FormContext)
  const nodeKey = useContext(ProtocolNodeContext)
  const nodeSnapshot = useProtocolNode(nodeKey ?? MISSING_FORM_OWNER_KEY)
  const node = nodeSnapshot?.node
  const formId = node && isElement(node) ? attributeValue(node, "form") : undefined
  const formNodeKey =
    formId !== undefined && formId !== ""
      ? `id:${formId}`
      : (context?.binding.formNodeKey ?? MISSING_FORM_OWNER_KEY)
  const formSnapshot = useProtocolNode(formNodeKey)

  if (!forms) throw new RegistryError("Expo Turbo forms require provider form controls")
  if (!nodeKey || !node || !isElement(node)) {
    throw new RegistryError("Expo Turbo form association requires an active component element")
  }
  if (formId === "") {
    throw new RegistryError("Expo Turbo form association must not be blank")
  }
  if (formId === undefined) {
    if (!context) {
      throw new RegistryError(
        "Expo Turbo form binding requires a form scope or explicit form association",
      )
    }
    return Object.freeze({ formNodeKey: context.binding.formNodeKey, registry: context.registry })
  }

  const form = session.tree.getElementById(formId)
  if (!form || formSnapshot?.node !== form) {
    throw new RegistryError("Expo Turbo form association references a missing form owner")
  }
  if (!componentRegistry.decode(form).definition.formOwner) {
    throw new RegistryError("Expo Turbo form association target is not a declared form owner")
  }
  return Object.freeze({ formNodeKey: form.key, registry: forms.controlsFor(form.key) })
}

function reportFormAnnouncementError(
  onError: ((event: ExpoTurboRenderError) => void) | undefined,
  nodeKey: string,
  cause: unknown,
): void {
  const error =
    cause instanceof Error
      ? cause
      : new RegistryError("Form submission announcement adapter failed")
  if (!onError) {
    queueMicrotask(() => {
      throw error
    })
    return
  }
  try {
    onError({ error, nodeKey })
  } catch (reporterError) {
    queueMicrotask(() => {
      throw new AggregateError(
        [error, reporterError],
        "Form submission announcement error reporter failed",
      )
    })
  }
}

function claimFormTerminalAnnouncement(
  session: DocumentSession,
  form: ProtocolElement,
  revision: number,
): boolean {
  let formRevisions = announcedFormTerminalRevisions.get(session)
  if (!formRevisions) {
    formRevisions = new WeakMap()
    announcedFormTerminalRevisions.set(session, formRevisions)
  }
  const announcedRevision = formRevisions.get(form) ?? -1
  if (announcedRevision >= revision) return false
  formRevisions.set(form, revision)
  return true
}

/**
 * Declares that the current registered component owns a logical native form.
 * The host-owned DocumentFormControls collection deliberately outlives React
 * effect replay; exact tree replacement remains its disposal boundary.
 */
export function ExpoTurboFormScope(props: ExpoTurboFormScopeProps): ReactNode {
  const {
    formAnnouncements,
    formComponent: FormComponent,
    forms,
    onError,
    registry: componentRegistry,
    session,
  } = useRenderer()
  const nodeKey = useContext(ProtocolNodeContext)
  if (!forms) throw new RegistryError("Expo Turbo forms require provider form controls")
  if (!nodeKey) throw new RegistryError("Expo Turbo forms require a component node")
  const formNode = session.tree.getNodeByKey(nodeKey)
  if (!formNode || !isElement(formNode)) {
    throw new RegistryError("Expo Turbo forms require an active component element")
  }
  if (!componentRegistry.decode(formNode).definition.formOwner) {
    throw new RegistryError("Expo Turbo form scope requires a declared form-owner component")
  }
  const registry = useMemo(() => forms.controlsFor(nodeKey), [forms, nodeKey])
  useEffect(() => {
    const release = registry.retainSubmissionScope()
    return () => queueMicrotask(release)
  }, [registry])
  const binding = useFormBinding(registry, nodeKey)
  const { terminalState } = binding
  const announcementBaseline = useRef({ node: formNode, revision: terminalState.revision })
  useEffect(() => {
    const baseline = announcementBaseline.current
    announcementBaseline.current = { node: formNode, revision: terminalState.revision }
    if (
      baseline.node !== formNode ||
      baseline.revision === terminalState.revision ||
      terminalState.status === "none" ||
      !formAnnouncements ||
      registry.submissionState.busy ||
      registry.submissionTerminalState !== terminalState ||
      session.tree.getNodeByKey(nodeKey) !== formNode
    ) {
      return
    }
    if (!claimFormTerminalAnnouncement(session, formNode, terminalState.revision)) return
    const event = Object.freeze({
      formNodeKey: nodeKey,
      terminalState: terminalState as FormSubmissionAnnouncementTerminalSnapshot,
    }) satisfies FormSubmissionAnnouncementEvent
    try {
      const delivery = formAnnouncements.announce(event)
      if (delivery) {
        void Promise.resolve(delivery).catch((error: unknown) => {
          reportFormAnnouncementError(onError, nodeKey, error)
        })
      }
    } catch (error) {
      reportFormAnnouncementError(onError, nodeKey, error)
    }
  }, [formAnnouncements, formNode, nodeKey, onError, registry, session, terminalState])
  const value = useMemo<ExpoTurboFormContextValue>(
    () => Object.freeze({ binding, registry }),
    [binding, registry],
  )
  const contents = FormComponent
    ? createElement(FormComponent, { ...binding }, props.children)
    : props.children
  return createElement(
    StateScopeBoundary,
    { kind: "form", nodeKey },
    createElement(FormContext.Provider, { value }, contents),
  )
}

export function useExpoTurboForm(): ExpoTurboFormBinding {
  const { formNodeKey, registry } = useResolvedFormRegistry()
  return useFormBinding(registry, formNodeKey)
}

export function useExpoTurboFormControl(
  descriptor: FormControlDescriptor,
): ExpoTurboFormControlBinding {
  const { registry } = useResolvedFormRegistry()
  const nodeKey = useContext(ProtocolNodeContext)
  const descriptorRef = useRef(descriptor)
  const registration = useRef<FormControlRegistration | undefined>(undefined)
  if (!nodeKey) throw new RegistryError("Expo Turbo form controls require a component node")

  const subscribe = useCallback(
    (listener: () => void) => registry.subscribeControlSubmission(nodeKey, listener),
    [nodeKey, registry],
  )
  const snapshot = useCallback(
    (): FormSubmitterActivitySnapshot => registry.controlSubmissionState(nodeKey),
    [nodeKey, registry],
  )
  const submissionState = useSyncExternalStore(subscribe, snapshot, snapshot)
  const subscribeInheritedDisabled = useCallback(
    (listener: () => void) => registry.subscribeControlInheritedDisabled(nodeKey, listener),
    [nodeKey, registry],
  )
  const inheritedDisabledSnapshot = useCallback(
    () => registry.controlInheritedDisabled(nodeKey),
    [nodeKey, registry],
  )
  const inheritedDisabled = useSyncExternalStore(
    subscribeInheritedDisabled,
    inheritedDisabledSnapshot,
    inheritedDisabledSnapshot,
  )
  const disabled = descriptor.disabled === true || inheritedDisabled || submissionState.pending

  useLayoutEffect(() => {
    descriptorRef.current = descriptor
    registration.current?.update(descriptor)
  }, [descriptor])
  useLayoutEffect(() => {
    const current = registry.register(nodeKey, descriptorRef.current)
    registration.current = current
    return () => {
      if (registration.current === current) registration.current = undefined
      current.unregister()
    }
  }, [nodeKey, registry])

  return useMemo(
    () =>
      Object.freeze({
        accessibilityState: Object.freeze({ disabled }),
        disabled,
        nodeKey,
        pending: submissionState.pending,
        selection: () => {
          const current = registration.current
          if (!current) throw new StateError("Form control registration is not active")
          return current.selection
        },
        ...(submissionState.submitsWith !== undefined
          ? { submitsWith: submissionState.submitsWith }
          : {}),
      }),
    [disabled, nodeKey, submissionState],
  )
}

export function useNodeDisposal(dispose: () => void): void {
  const { session } = useRenderer()
  const nodeKey = useContext(ProtocolNodeContext)
  const disposeRef = useRef(dispose)
  disposeRef.current = dispose
  if (!nodeKey) throw new RegistryError("Expo Turbo node disposal requires a component node")
  useEffect(() => {
    let disposed = false
    const disposeOnce = () => {
      if (disposed) return
      disposed = true
      disposeRef.current()
    }
    const unregister = session.registerDisposal(nodeKey, disposeOnce)
    return () => {
      unregister()
      disposeOnce()
    }
  }, [nodeKey, session])
}

export function useFrameControllerState(controller: FrameController): FrameControllerSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  )
  const snapshot = useCallback(() => controller.state, [controller])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function useDocumentVisitControllerState(
  controller: DocumentVisitController,
): DocumentVisitSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  )
  const snapshot = useCallback(() => controller.state, [controller])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function useExpoTurboDocument(): ExpoTurboDocumentBinding | undefined {
  return useContext(DocumentContext)
}

export type ExpoTurboDocumentLinkDelegation =
  | DocumentVisitDelegation
  | Readonly<{
      kind: "external"
      reason: "opt-out"
      status: "delegated"
      url: string
    }>
  | Readonly<{
      kind: "external"
      reason: "scheme"
      scheme: ExternalDocumentLinkScheme
      status: "delegated"
      url: string
    }>
  | Readonly<{
      action: "advance"
      kind: "navigation"
      reason: "opt-out"
      status: "delegated"
      url: string
    }>

export type ExpoTurboDocumentLinkResult =
  | DocumentVisitResult
  | ExpoTurboDocumentLinkDelegation
  | FormSubmissionReport
  | Readonly<{
      kind: "disabled"
      status: "ignored"
    }>
  | FrameVisitResult

export type ExpoTurboDocumentLinkActivation = () => Promise<ExpoTurboDocumentLinkResult>

export function useExpoTurboDocumentLink(href: string): ExpoTurboDocumentLinkActivation {
  const { documentController, formLinks, frames, session } = useRenderer()
  const navigation = useContext(NavigationContext)
  const nodeKey = useContext(ProtocolNodeContext)
  const node = nodeKey ? session.tree.getNodeByKey(nodeKey) : undefined
  const activate = useCallback(async () => {
    if (!documentController || !nodeKey || !node || !isElement(node)) {
      throw new TargetError("Document link is outside the active document")
    }
    if (session.tree.getNodeByKey(nodeKey) !== node) {
      throw new TargetError("Document link is outside the active document")
    }
    if (attributeValue(node, "disabled") !== undefined) {
      return Object.freeze({ kind: "disabled", status: "ignored" })
    }
    const browserTarget = attributeValue(node, "target")
    if (browserTarget !== undefined && browserTarget !== "" && browserTarget !== "_self") {
      throw new TargetError("Document link metadata requires unsupported navigation behavior")
    }
    for (const name of UNSUPPORTED_DOCUMENT_LINK_ATTRIBUTES) {
      if (attributeValue(node, name) !== undefined) {
        throw new TargetError("Document link metadata requires unsupported navigation behavior")
      }
    }
    const actionValue = attributeValue(node, "data-turbo-action")
    const action = exactVisitAction(actionValue)
    const documentUrl = session.tree.document.url
    if (!documentUrl) throw new TargetError("Document links require an active document URL")
    const linkUrl = resolveDocumentLinkUrl(href, documentUrl)
    if (linkUrl.kind === "external") {
      if (!navigation) throw new TargetError("Document link delegation requires host navigation")
      await navigation.openExternal(linkUrl.url)
      return Object.freeze({
        kind: "external",
        reason: "scheme",
        scheme: linkUrl.scheme,
        status: "delegated",
        url: linkUrl.url,
      })
    }
    let current: ProtocolNode | null = node
    let foundTurboSetting = false
    let nearestFrameId: string | null | undefined
    let optedOut = false
    while (current && current.kind !== "document") {
      if (current.kind === "frame" && nearestFrameId === undefined) {
        nearestFrameId = attributeValue(current, "id") || null
      }
      if (!foundTurboSetting && isElement(current)) {
        const setting = attributeValue(current, "data-turbo")
        if (setting !== undefined) {
          foundTurboSetting = true
          optedOut = setting === "false"
        }
      }
      current = current.parent
    }
    const elementTarget = attributeValue(node, "data-turbo-frame")
    const resolved = linkUrl.resolution
    const documentVisitOptions = navigation ? { navigation } : {}
    if (!optedOut && classifyTopLevelLocation(session.tree, href).classification !== "visitable") {
      return documentController.visit(href, documentVisitOptions)
    }
    if (
      !optedOut &&
      (attributeValue(node, "data-turbo-method") !== undefined ||
        attributeValue(node, "data-turbo-stream") !== undefined)
    ) {
      if (!formLinks) {
        throw new TargetError("Generated form links require provider form-link submissions")
      }
      if (!formLinks.shouldInterceptSubmission(node.key)) {
        throw new TargetError("Generated form-link submission is disabled")
      }
      return formLinks.submit(node.key, href)
    }
    if (!optedOut && nearestFrameId !== undefined) {
      if (!nearestFrameId) {
        throw new TargetError("Frame-scoped document links require an identified Frame")
      }
      if (!frames) {
        throw new TargetError("Frame-scoped document links require provider Frame controllers", {
          frameId: nearestFrameId,
        })
      }
      const frameAction = linkFrameVisitAction(actionValue)
      return frames.visit(href, {
        ...(frameAction !== undefined ? { action: frameAction } : {}),
        ...(elementTarget !== undefined ? { elementTarget } : {}),
        frame: nearestFrameId,
      })
    }
    if (!optedOut && elementTarget && elementTarget !== "_top") {
      const targetFrame = session.tree.getElementById(elementTarget)
      if (targetFrame?.kind === "frame" && attributeValue(targetFrame, "disabled") === undefined) {
        if (!frames) {
          throw new TargetError("Named Frame document links require provider Frame controllers", {
            frameId: elementTarget,
          })
        }
        const frameAction = linkFrameVisitAction(actionValue)
        return frames.visit(href, {
          ...(frameAction !== undefined ? { action: frameAction } : {}),
          elementTarget,
          frame: elementTarget,
        })
      }
    }
    if (optedOut) {
      if (!navigation) throw new TargetError("Document link delegation requires host navigation")
      if (resolved.urlOrigin !== resolved.documentOrigin) {
        await navigation.openExternal(resolved.url)
        return Object.freeze({
          kind: "external",
          reason: "opt-out",
          status: "delegated",
          url: resolved.url,
        })
      }
      await navigation.visit(resolved.url, "advance")
      return Object.freeze({
        action: "advance",
        kind: "navigation",
        reason: "opt-out",
        status: "delegated",
        url: resolved.url,
      })
    }
    return documentController.visit(href, {
      ...(action !== undefined ? { action } : {}),
      ...documentVisitOptions,
    })
  }, [documentController, formLinks, frames, href, navigation, node, nodeKey, session])
  if (!documentController) {
    throw new RegistryError("Expo Turbo document links require a provider visit controller")
  }
  if (!nodeKey) throw new RegistryError("Expo Turbo document links require a component node")
  if (!node || !isElement(node)) {
    throw new RegistryError("Expo Turbo document links require an active component element")
  }
  return activate
}

export function useExpoTurboFrame(): ExpoTurboFrameBinding | undefined {
  return useContext(FrameContext)
}

interface ErrorBoundaryProps {
  readonly children?: ReactNode
  readonly nodeKey: string
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
  readonly resetIdentity?: unknown
  readonly revision: number | string
}

interface ErrorBoundaryState {
  readonly error: Error | null
  readonly resetIdentity: unknown
  readonly revision: number | string
}

const alreadyReportedRenderErrors = new WeakSet<Error>()

class NodeErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
    resetIdentity: this.props.resetIdentity,
    revision: this.props.revision,
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): ErrorBoundaryState | null {
    return state.revision === props.revision && state.resetIdentity === props.resetIdentity
      ? null
      : {
          error: null,
          resetIdentity: props.resetIdentity,
          revision: props.revision,
        }
  }

  static getDerivedStateFromError(error: Error): Pick<ErrorBoundaryState, "error"> {
    return { error }
  }

  componentDidCatch(error: Error): void {
    if (alreadyReportedRenderErrors.has(error)) return
    this.props.onError?.({ error, nodeKey: this.props.nodeKey })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      this.props.renderError?.({ error: this.state.error, nodeKey: this.props.nodeKey }) ?? null
    )
  }
}

function renderChildren(nodes: readonly ProtocolNode[]): ReactNode[] {
  return nodes.map((node) =>
    createElement(ProtocolNodeView, {
      key: node.key,
      nodeKey: node.key,
    }),
  )
}

function RegisteredElement(props: Readonly<{ node: ProtocolElement }>): ReactNode {
  const { registry } = useRenderer()
  const decoded: DecodedComponent = registry.decode(props.node)
  let children: ReactNode
  if (decoded.definition.children === "text") children = decoded.text ?? ""
  else if (decoded.definition.children === "nodes") children = renderChildren(decoded.children)
  const component = decoded.definition.component as ComponentType<
    Readonly<Record<string, unknown> & { children?: ReactNode }>
  >
  const componentProps = decoded.props as Readonly<Record<string, unknown>>
  const rendered =
    children === undefined
      ? createElement(component, componentProps)
      : createElement(component, componentProps, children)
  return createElement(
    ProtocolNodeContext.Provider,
    { value: props.node.key },
    createElement(ComponentTagContext.Provider, { value: decoded.definition.tag }, rendered),
  )
}

interface RegisteredElementBoundaryProps {
  readonly node: ProtocolElement
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
  readonly revision: number | string
}

function RegisteredElementBoundary(props: RegisteredElementBoundaryProps): ReactNode {
  return createElement(
    NodeErrorBoundary,
    {
      nodeKey: props.node.key,
      onError: props.onError,
      renderError: props.renderError,
      revision: props.revision,
    },
    createElement(RegisteredElement, { node: props.node }),
  )
}

function AssociatedRegisteredElementBoundary(
  props: RegisteredElementBoundaryProps & Readonly<{ formId: string }>,
): ReactNode {
  const owner = useProtocolNode(`id:${props.formId}`)
  return createElement(RegisteredElementBoundary, {
    ...props,
    revision: `${props.revision}:${owner?.identity ?? "missing"}`,
  })
}

interface ConnectedFrameProps {
  readonly autofocus: AutofocusAdapter | undefined
  readonly frameComponent: ComponentType<ExpoTurboFrameBoundaryProps> | undefined
  readonly frameId: string
  readonly frames: FrameControllerCollection
  readonly node: ProtocolElement
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
}

function consumeUnexpectedAdapterResult(result: unknown): void {
  if ((typeof result !== "object" || result === null) && typeof result !== "function") return
  try {
    void Promise.resolve(result).catch(() => undefined)
  } catch {
    // The redacted StateError from the caller is the only exposed host failure.
  }
}

function focusFirstAvailableCandidate(
  adapter: AutofocusAdapter,
  candidates: readonly string[],
  scope: "Document" | "Frame",
  frameId?: string,
): void {
  const context = frameId ? { frameId } : {}
  for (const candidate of candidates) {
    let available: unknown
    try {
      available = adapter.canFocus(candidate)
    } catch {
      throw new StateError(`${scope} autofocus availability check failed`, context)
    }
    if (typeof available !== "boolean") {
      consumeUnexpectedAdapterResult(available)
      throw new StateError(`${scope} autofocus availability check failed`, context)
    }
    if (!available) continue

    let result: unknown
    try {
      result = adapter.focus(candidate)
    } catch {
      throw new StateError(`${scope} autofocus failed`, context)
    }
    if (result !== undefined) {
      consumeUnexpectedAdapterResult(result)
      throw new StateError(`${scope} autofocus failed`, context)
    }
    return
  }
}

function applyAutofocus(
  adapter: AutofocusAdapter,
  candidates: readonly string[],
  nodeKey: string,
  onError: ((event: ExpoTurboRenderError) => void) | undefined,
  scope: "Document" | "Frame",
  frameId?: string,
): void {
  try {
    focusFirstAvailableCandidate(adapter, candidates, scope, frameId)
  } catch (error) {
    const reported = error instanceof Error ? error : new StateError(`${scope} autofocus failed`)
    if (!onError) throw reported
    try {
      onError({ error: reported, nodeKey })
    } catch {
      const reportingError = new StateError(
        `${scope} autofocus error reporting failed`,
        frameId ? { frameId } : {},
      )
      alreadyReportedRenderErrors.add(reportingError)
      throw reportingError
    }
  }
}

function ConnectedFrame(props: ConnectedFrameProps): ReactNode {
  const controller = props.frames.get(props.frameId)
  const state = useFrameControllerState(controller)
  const accessibilityState = useMemo<ExpoTurboFrameAccessibilityState>(
    () => Object.freeze({ busy: state.busy }),
    [state.busy],
  )
  const binding = useMemo<ExpoTurboFrameBinding>(
    () => Object.freeze({ accessibilityState, controller, state }),
    [accessibilityState, controller, state],
  )
  useEffect(() => {
    void controller.connect().catch(() => undefined)
    return () => controller.disconnect()
  }, [controller])
  useEffect(
    () =>
      controller.subscribeErrors((error) => {
        props.onError?.({ error, nodeKey: props.node.key })
      }),
    [controller, props.node.key, props.onError],
  )
  useLayoutEffect(() => {
    const candidates = consumeFrameAutofocus(controller, state.revision)
    if (!candidates || !props.autofocus) return
    applyAutofocus(
      props.autofocus,
      candidates,
      props.node.key,
      props.onError,
      "Frame",
      props.frameId,
    )
  }, [controller, props.autofocus, props.frameId, props.node.key, props.onError, state.revision])
  const children = useMemo(
    () => createElement(Fragment, null, renderChildren(props.node.children)),
    [props.node.children],
  )
  const rendered = props.frameComponent
    ? createElement(
        NodeErrorBoundary,
        {
          nodeKey: props.node.key,
          onError: props.onError,
          renderError: props.renderError,
          revision: state.revision,
        },
        createElement(props.frameComponent, binding, children),
      )
    : children
  return createElement(FrameContext.Provider, { value: binding }, rendered)
}

interface ConnectedDocumentProps {
  readonly children?: ReactNode
  readonly controller: DocumentVisitController
  readonly documentComponent: ComponentType<ExpoTurboDocumentBoundaryProps> | undefined
  readonly nodeKey: string
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
}

interface DocumentAutofocusBoundaryProps {
  readonly children?: ReactNode
  readonly document: ProtocolDocument
  readonly generation: number
}

function DocumentAutofocusBoundary(props: DocumentAutofocusBoundaryProps): ReactNode {
  const { autofocus, onError, session } = useRenderer()
  useLayoutEffect(() => {
    const candidates = consumeDocumentAutofocus(session, props.document, props.generation)
    if (!candidates || !autofocus) return
    applyAutofocus(autofocus, candidates, props.document.key, onError, "Document")
  }, [autofocus, onError, props.document, props.generation, session])
  return props.children
}

function ConnectedDocument(props: ConnectedDocumentProps): ReactNode {
  const state = useDocumentVisitControllerState(props.controller)
  const accessibilityState = useMemo<ExpoTurboDocumentAccessibilityState>(
    () => Object.freeze({ busy: state.busy }),
    [state.busy],
  )
  const binding = useMemo<ExpoTurboDocumentBinding>(
    () => Object.freeze({ accessibilityState, controller: props.controller, state }),
    [accessibilityState, props.controller, state],
  )
  useEffect(
    () =>
      props.controller.subscribeErrors((error) => {
        props.onError?.({ error, nodeKey: props.nodeKey })
      }),
    [props.controller, props.nodeKey, props.onError],
  )
  const rendered = props.documentComponent
    ? createElement(
        NodeErrorBoundary,
        {
          nodeKey: props.nodeKey,
          onError: props.onError,
          renderError: props.renderError,
          revision: state.revision,
        },
        createElement(props.documentComponent, binding, props.children),
      )
    : props.children
  return createElement(DocumentContext.Provider, { value: binding }, rendered)
}

interface ConnectedCableStreamSourceProps {
  readonly node: ProtocolElement
  readonly streamSources: CableStreamSourceCollection
}

function ConnectedCableStreamSource(props: ConnectedCableStreamSourceProps): ReactNode {
  useLayoutEffect(() => {
    try {
      return props.streamSources.retain(props.node)
    } catch (error) {
      if (error instanceof Error && wasCableStreamSourceErrorReported(error)) {
        alreadyReportedRenderErrors.add(error)
      }
      throw error
    }
  }, [props.node, props.streamSources])
  return null
}

function ProtocolElementView(
  props: Readonly<{ node: ProtocolElement; revision: number }>,
): ReactNode {
  const context = useRenderer()
  if (props.node.kind === "stream-source") {
    return context.streamSources
      ? createElement(
          NodeErrorBoundary,
          {
            nodeKey: props.node.key,
            onError: context.onError,
            renderError: context.renderError,
            resetIdentity: context.streamSources,
            revision: props.revision,
          },
          createElement(ConnectedCableStreamSource, {
            node: props.node,
            streamSources: context.streamSources,
          }),
        )
      : null
  }
  if (props.node.kind === "stream" || props.node.kind === "template") return null
  if (props.node.kind === "frame") {
    const frameId = attributeValue(props.node, "id")
    const rendered =
      context.frames && frameId
        ? createElement(ConnectedFrame, {
            autofocus: context.autofocus,
            frameComponent: context.frameComponent,
            frameId,
            frames: context.frames,
            node: props.node,
            onError: context.onError,
            renderError: context.renderError,
          })
        : createElement(
            FrameContext.Provider,
            { value: undefined },
            createElement(Fragment, null, renderChildren(props.node.children)),
          )
    return createElement(
      NodeErrorBoundary,
      {
        nodeKey: props.node.key,
        onError: context.onError,
        renderError: context.renderError,
        revision: props.revision,
      },
      createElement(
        StateScopeBoundary,
        {
          kind: "frame",
          nodeKey: props.node.key,
        },
        rendered,
      ),
    )
  }

  const formId = attributeValue(props.node, "form")
  const boundaryProps = {
    node: props.node,
    onError: context.onError,
    renderError: context.renderError,
    revision: props.revision,
  }
  return formId !== undefined && formId !== ""
    ? createElement(AssociatedRegisteredElementBoundary, { ...boundaryProps, formId })
    : createElement(RegisteredElementBoundary, boundaryProps)
}

function ProtocolNodeView(props: Readonly<{ nodeKey: string }>): ReactNode {
  const snapshot = useProtocolNode(props.nodeKey)
  if (!snapshot) return null
  const node = snapshot.node
  if (node.kind === "comment") return null
  if (node.kind === "text") return renderedTextValue(node) || null
  if (node.kind === "document") return createElement(Fragment, null, renderChildren(node.children))
  return createElement(ProtocolElementView, {
    key: snapshot.identity,
    node,
    revision: snapshot.revision,
  })
}

export function ExpoTurboRoot(): ReactNode {
  const context = useRenderer()
  const { session } = context
  const root = useProtocolNode(session.tree.document.key)
  if (root?.node.kind !== "document") return null
  const children = createElement(Fragment, null, renderChildren(root.node.children))
  const rendered = context.documentController
    ? createElement(
        ConnectedDocument,
        {
          controller: context.documentController,
          documentComponent: context.documentComponent,
          nodeKey: root.node.key,
          onError: context.onError,
          renderError: context.renderError,
        },
        children,
      )
    : children
  return createElement(
    NodeErrorBoundary,
    {
      nodeKey: root.node.key,
      onError: context.onError,
      renderError: context.renderError,
      revision: root.revision,
    },
    createElement(
      DocumentAutofocusBoundary,
      {
        document: root.node,
        generation: session.treeGeneration,
      },
      rendered,
    ),
  )
}
