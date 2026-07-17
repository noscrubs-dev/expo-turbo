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
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react"

import {
  type ComponentStyleLayers,
  resolveComponentStyle,
  type StyleAdapter,
} from "../adapters/styles"
import type { DocumentLoadReport } from "../core/document-loader"
import type {
  DocumentVisitController,
  DocumentVisitSnapshot,
} from "../core/document-visit-controller"
import { RegistryError, TargetError } from "../core/errors"
import type { FrameController, FrameControllerSnapshot } from "../core/frame-controller"
import type { FrameControllerCollection } from "../core/frame-controller-registry"
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
  type ProtocolElement,
  type ProtocolNode,
  renderedTextValue,
} from "../core/tree"
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

interface RendererContextValue {
  readonly actions: ComponentActionExecutor | undefined
  readonly documentComponent: ComponentType<ExpoTurboDocumentBoundaryProps> | undefined
  readonly documentController: DocumentVisitController | undefined
  readonly frameComponent: ComponentType<ExpoTurboFrameBoundaryProps> | undefined
  readonly frames: FrameControllerCollection | undefined
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly registry: RenderRegistry
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
  readonly session: DocumentSession
  readonly scopes: DocumentStateScopes | undefined
  readonly state: DocumentStateStore | undefined
  readonly styles: StyleAdapter | undefined
}

const RendererContext = createContext<RendererContextValue | undefined>(undefined)
const DocumentContext = createContext<ExpoTurboDocumentBinding | undefined>(undefined)
const FrameContext = createContext<ExpoTurboFrameBinding | undefined>(undefined)
const ProtocolNodeContext = createContext<string | undefined>(undefined)
const ComponentTagContext = createContext<string | undefined>(undefined)
const StateScopeContext = createContext<DocumentStateStore | undefined>(undefined)
const UNSUPPORTED_DOCUMENT_LINK_ATTRIBUTES = [
  "action",
  "confirm",
  "data-turbo-action",
  "data-turbo-confirm",
  "data-turbo-frame",
  "data-turbo-method",
  "data-turbo-stream",
  "disabled",
  "method",
  "stream",
  "target",
] as const

export interface ExpoTurboProviderProps {
  readonly actions?: ComponentActionExecutor
  readonly children?: ReactNode
  readonly documentComponent?: ComponentType<ExpoTurboDocumentBoundaryProps>
  readonly documentController?: DocumentVisitController
  readonly frameComponent?: ComponentType<ExpoTurboFrameBoundaryProps>
  readonly frames?: FrameControllerCollection
  readonly onError?: (event: ExpoTurboRenderError) => void
  readonly registry: RenderRegistry
  readonly renderError?: (event: ExpoTurboRenderError) => ReactNode
  readonly scopes?: DocumentStateScopes
  readonly session: DocumentSession
  readonly state?: DocumentStateStore
  readonly styles?: StyleAdapter
}

export function ExpoTurboProvider(props: ExpoTurboProviderProps): ReactNode {
  useEffect(() => () => props.scopes?.dispose(), [props.scopes])
  useEffect(() => () => props.state?.dispose(), [props.state])
  const value = useMemo<RendererContextValue>(
    () => ({
      actions: props.actions,
      documentComponent: props.documentComponent,
      documentController: props.documentController,
      frameComponent: props.frameComponent,
      frames: props.frames,
      onError: props.onError,
      registry: props.registry,
      renderError: props.renderError,
      scopes: props.scopes,
      session: props.session,
      state: props.state,
      styles: props.styles,
    }),
    [
      props.actions,
      props.documentComponent,
      props.documentController,
      props.frameComponent,
      props.frames,
      props.onError,
      props.registry,
      props.renderError,
      props.scopes,
      props.session,
      props.state,
      props.styles,
    ],
  )
  return createElement(RendererContext.Provider, { value }, props.children)
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

export type ExpoTurboDocumentLinkActivation = () => Promise<DocumentLoadReport>

export function useExpoTurboDocumentLink(href: string): ExpoTurboDocumentLinkActivation {
  const { documentController, session } = useRenderer()
  const nodeKey = useContext(ProtocolNodeContext)
  const node = nodeKey ? session.tree.getNodeByKey(nodeKey) : undefined
  const activate = useCallback(() => {
    if (!documentController || !nodeKey || !node || !isElement(node)) {
      return Promise.reject(new TargetError("Document link is outside the active document"))
    }
    if (session.tree.getNodeByKey(nodeKey) !== node) {
      return Promise.reject(new TargetError("Document link is outside the active document"))
    }
    for (const name of UNSUPPORTED_DOCUMENT_LINK_ATTRIBUTES) {
      if (attributeValue(node, name) !== undefined) {
        return Promise.reject(
          new TargetError("Document link metadata requires unsupported navigation behavior"),
        )
      }
    }
    let current: ProtocolNode | null = node
    let foundTurboSetting = false
    while (current && current.kind !== "document") {
      if (current.kind === "frame") {
        const frameId = attributeValue(current, "id")
        return Promise.reject(
          new TargetError("Frame-scoped document links require Frame navigation", {
            ...(frameId ? { frameId } : {}),
          }),
        )
      }
      if (!foundTurboSetting && isElement(current)) {
        const setting = attributeValue(current, "data-turbo")
        if (setting !== undefined) {
          foundTurboSetting = true
          if (setting === "false") {
            return Promise.reject(
              new TargetError("Opted-out document links require host navigation"),
            )
          }
        }
      }
      current = current.parent
    }
    const documentUrl = session.tree.document.url
    if (documentUrl) {
      try {
        if (new URL(href, documentUrl).href.includes("#")) {
          return Promise.reject(
            new TargetError("Document link fragments require navigation support"),
          )
        }
      } catch {
        // The document controller owns typed URL admission and redaction.
      }
    }
    return documentController.visit(href)
  }, [documentController, href, node, nodeKey, session])
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
  readonly revision: number
}

interface ErrorBoundaryState {
  readonly error: Error | null
  readonly revision: number
}

class NodeErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, revision: this.props.revision }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): ErrorBoundaryState | null {
    return state.revision === props.revision ? null : { error: null, revision: props.revision }
  }

  static getDerivedStateFromError(error: Error): Pick<ErrorBoundaryState, "error"> {
    return { error }
  }

  componentDidCatch(error: Error): void {
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

interface ConnectedFrameProps {
  readonly frameComponent: ComponentType<ExpoTurboFrameBoundaryProps> | undefined
  readonly frameId: string
  readonly frames: FrameControllerCollection
  readonly node: ProtocolElement
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
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

function ProtocolElementView(
  props: Readonly<{ node: ProtocolElement; revision: number }>,
): ReactNode {
  const context = useRenderer()
  if (
    props.node.kind === "stream" ||
    props.node.kind === "stream-source" ||
    props.node.kind === "template"
  ) {
    return null
  }
  if (props.node.kind === "frame") {
    const frameId = attributeValue(props.node, "id")
    const rendered =
      context.frames && frameId
        ? createElement(ConnectedFrame, {
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

  return createElement(
    NodeErrorBoundary,
    {
      nodeKey: props.node.key,
      onError: context.onError,
      renderError: context.renderError,
      revision: props.revision,
    },
    createElement(RegisteredElement, { node: props.node }),
  )
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
  if (!context.documentController) return children
  return createElement(
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
}
