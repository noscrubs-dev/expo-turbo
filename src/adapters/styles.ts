import { PropsError, RegistryError } from "../core/errors"

const TOKEN_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/
const MAX_TOKEN_LENGTH = 64

export interface StyleResolveContext {
  readonly component: string
}

export interface StyleTokenDefinition<TStyle> {
  readonly components?: readonly string[]
  readonly group?: string
  readonly style: TStyle
}

export interface StyleAdapter<TStyle = unknown, Token extends string = string> {
  readonly maxTokens: number
  readonly tokens: readonly Token[]
  compose(styles: readonly TStyle[]): TStyle
  resolve(tokens: readonly string[], context: StyleResolveContext): TStyle
}

export interface ComponentStyleLayers<TStyle> {
  readonly component?: TStyle
  readonly props?: TStyle
  readonly tokens: readonly string[]
}

export interface DefineStyleAdapterConfig<Token extends string, TStyle> {
  readonly compose: (styles: readonly TStyle[]) => TStyle
  readonly maxTokens: number
  readonly tokens: Readonly<Record<Token, StyleTokenDefinition<TStyle>>>
}

function validateToken(token: string): void {
  if (token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
    throw new RegistryError(
      `Style adapter token ${JSON.stringify(token)} must be a lowercase semantic token of at most ${MAX_TOKEN_LENGTH} characters`,
    )
  }
}

function invalidStyleToken(message: string, context: StyleResolveContext): PropsError {
  return new PropsError(`${message} for ${JSON.stringify(context.component)}`, {
    target: context.component,
  })
}

export function defineStyleAdapter<const Token extends string, TStyle>(
  config: DefineStyleAdapterConfig<Token, TStyle>,
): StyleAdapter<TStyle, Token> {
  if (!Number.isInteger(config.maxTokens) || config.maxTokens < 1) {
    throw new RegistryError("Style adapters require a positive integer token limit")
  }

  const definitions = new Map<Token, StyleTokenDefinition<TStyle>>()
  for (const [token, definition] of Object.entries(config.tokens) as [
    Token,
    StyleTokenDefinition<TStyle>,
  ][]) {
    validateToken(token)
    const components = definition.components ? [...definition.components] : undefined
    if (components) {
      if (components.length === 0 || components.some((component) => !component.trim())) {
        throw new RegistryError(
          `Style adapter token ${JSON.stringify(token)} requires nonblank components`,
        )
      }
      if (new Set(components).size !== components.length) {
        throw new RegistryError(
          `Style adapter token ${JSON.stringify(token)} has duplicate components`,
        )
      }
      components.sort()
    }
    if (definition.group !== undefined) validateToken(definition.group)
    definitions.set(
      token,
      Object.freeze({
        ...(components ? { components: Object.freeze(components) } : {}),
        ...(definition.group ? { group: definition.group } : {}),
        style: definition.style,
      }),
    )
  }
  const tokens = Object.freeze([...definitions.keys()].sort())

  return Object.freeze({
    compose(styles: readonly TStyle[]): TStyle {
      return config.compose(Object.freeze([...styles]))
    },
    maxTokens: config.maxTokens,
    resolve(requested: readonly string[], context: StyleResolveContext): TStyle {
      if (!context.component.trim()) {
        throw new RegistryError("Style resolution requires a component name")
      }
      if (requested.length > config.maxTokens) {
        throw invalidStyleToken("Too many style tokens", context)
      }

      const groups = new Set<string>()
      const used = new Set<string>()
      const styles: TStyle[] = []
      for (const token of requested) {
        const definition = definitions.get(token as Token)
        if (!definition) throw invalidStyleToken("Unknown style token", context)
        if (used.has(token)) throw invalidStyleToken("Duplicate style token", context)
        used.add(token)
        if (definition.components && !definition.components.includes(context.component)) {
          throw invalidStyleToken("Style token is not available on this component", context)
        }
        if (definition.group) {
          if (groups.has(definition.group)) {
            throw invalidStyleToken("Conflicting style tokens", context)
          }
          groups.add(definition.group)
        }
        styles.push(definition.style)
      }
      return config.compose(Object.freeze(styles))
    },
    tokens,
  })
}

export function resolveComponentStyle<TStyle, Token extends string>(
  adapter: StyleAdapter<TStyle, Token>,
  layers: ComponentStyleLayers<TStyle>,
  context: StyleResolveContext,
): TStyle {
  const styles: TStyle[] = []
  if (layers.component !== undefined) styles.push(layers.component)
  styles.push(adapter.resolve(layers.tokens, context))
  if (layers.props !== undefined) styles.push(layers.props)
  return adapter.compose(Object.freeze(styles))
}
