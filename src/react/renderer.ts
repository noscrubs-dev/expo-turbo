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
  useSyncExternalStore,
} from "react"

import { RegistryError } from "../core/errors"
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

interface RendererContextValue {
  readonly actions: ComponentActionExecutor | undefined
  readonly frames: FrameControllerCollection | undefined
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly registry: RenderRegistry
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
  readonly session: DocumentSession
  readonly scopes: DocumentStateScopes | undefined
  readonly state: DocumentStateStore | undefined
}

const RendererContext = createContext<RendererContextValue | undefined>(undefined)
const ProtocolNodeContext = createContext<string | undefined>(undefined)
const StateScopeContext = createContext<DocumentStateStore | undefined>(undefined)

export interface ExpoTurboProviderProps {
  readonly actions?: ComponentActionExecutor
  readonly children?: ReactNode
  readonly frames?: FrameControllerCollection
  readonly onError?: (event: ExpoTurboRenderError) => void
  readonly registry: RenderRegistry
  readonly renderError?: (event: ExpoTurboRenderError) => ReactNode
  readonly scopes?: DocumentStateScopes
  readonly session: DocumentSession
  readonly state?: DocumentStateStore
}

export function ExpoTurboProvider(props: ExpoTurboProviderProps): ReactNode {
  useEffect(() => () => props.scopes?.dispose(), [props.scopes])
  useEffect(() => () => props.state?.dispose(), [props.state])
  const value = useMemo<RendererContextValue>(
    () => ({
      actions: props.actions,
      frames: props.frames,
      onError: props.onError,
      registry: props.registry,
      renderError: props.renderError,
      scopes: props.scopes,
      session: props.session,
      state: props.state,
    }),
    [
      props.actions,
      props.frames,
      props.onError,
      props.registry,
      props.renderError,
      props.scopes,
      props.session,
      props.state,
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
  if (!nodeKey) throw new RegistryError("Expo Turbo node disposal requires a component node")
  useEffect(() => session.registerDisposal(nodeKey, dispose), [dispose, nodeKey, session])
}

export function useFrameControllerState(controller: FrameController): FrameControllerSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  )
  const snapshot = useCallback(() => controller.state, [controller])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
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
}

class NodeErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error): void {
    this.props.onError?.({ error, nodeKey: this.props.nodeKey })
  }

  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error && previous.revision !== this.props.revision) {
      this.setState({ error: null })
    }
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
  return createElement(ProtocolNodeContext.Provider, { value: props.node.key }, rendered)
}

interface ConnectedFrameProps {
  readonly frameId: string
  readonly frames: FrameControllerCollection
  readonly node: ProtocolElement
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
}

function ConnectedFrame(props: ConnectedFrameProps): ReactNode {
  const controller = useMemo(() => props.frames.get(props.frameId), [props.frameId, props.frames])
  useFrameControllerState(controller)
  useEffect(() => {
    const unsubscribeErrors = controller.subscribeErrors((error) => {
      props.onError?.({ error, nodeKey: props.node.key })
    })
    void controller.connect().catch(() => undefined)
    return () => {
      unsubscribeErrors()
      props.frames.delete(props.frameId, controller)
    }
  }, [controller, props.frameId, props.frames, props.node.key, props.onError])
  return createElement(Fragment, null, renderChildren(props.node.children))
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
            frameId,
            frames: context.frames,
            node: props.node,
            onError: context.onError,
          })
        : createElement(Fragment, null, renderChildren(props.node.children))
    return createElement(
      StateScopeBoundary,
      {
        kind: "frame",
        nodeKey: props.node.key,
      },
      rendered,
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
  return createElement(ProtocolElementView, { node, revision: snapshot.revision })
}

export function ExpoTurboRoot(): ReactNode {
  const { session } = useRenderer()
  const root = useProtocolNode(session.tree.document.key)
  if (root?.node.kind !== "document") return null
  return createElement(Fragment, null, renderChildren(root.node.children))
}
