import {
  Component,
  type ComponentType,
  createContext,
  createElement,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react"

import { RegistryError } from "../core/errors"
import type { DocumentSession, NodeSnapshot } from "../core/session"
import { attributeValue, type ProtocolElement, type ProtocolNode } from "../core/tree"
import type { ComponentRegistry, DecodedComponent, RegistryComponent } from "../registry/registry"

type RenderRegistry = Pick<ComponentRegistry<RegistryComponent>, "decode">

export interface ExpoTurboRenderError {
  readonly error: Error
  readonly nodeKey: string
}

interface RendererContextValue {
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly registry: RenderRegistry
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
  readonly session: DocumentSession
}

const RendererContext = createContext<RendererContextValue | undefined>(undefined)

export interface ExpoTurboProviderProps {
  readonly children?: ReactNode
  readonly onError?: (event: ExpoTurboRenderError) => void
  readonly registry: RenderRegistry
  readonly renderError?: (event: ExpoTurboRenderError) => ReactNode
  readonly session: DocumentSession
}

export function ExpoTurboProvider(props: ExpoTurboProviderProps): ReactNode {
  const value = useMemo<RendererContextValue>(
    () => ({
      onError: props.onError,
      registry: props.registry,
      renderError: props.renderError,
      session: props.session,
    }),
    [props.onError, props.registry, props.renderError, props.session],
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

function normalizedText(node: ProtocolNode): string {
  if (node.kind !== "text") return ""
  let ancestor = node.parent
  while (ancestor && ancestor.kind !== "document") {
    if (attributeValue(ancestor, "xml:space") === "preserve") return node.value
    ancestor = ancestor.parent
  }
  return node.value.trim() === "" ? "" : node.value.replace(/\s+/g, " ")
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
  return children === undefined
    ? createElement(component, componentProps)
    : createElement(component, componentProps, children)
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
  if (props.node.kind === "frame")
    return createElement(Fragment, null, renderChildren(props.node.children))

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
  if (node.kind === "text") return normalizedText(node) || null
  if (node.kind === "document") return createElement(Fragment, null, renderChildren(node.children))
  return createElement(ProtocolElementView, { node, revision: snapshot.revision })
}

export function ExpoTurboRoot(): ReactNode {
  const { session } = useRenderer()
  const root = useProtocolNode(session.tree.document.key)
  if (root?.node.kind !== "document") return null
  return createElement(Fragment, null, renderChildren(root.node.children))
}
