export type ExpoTurboErrorCode =
  | "action"
  | "auth"
  | "content_type"
  | "frame_missing"
  | "parse"
  | "props"
  | "registry"
  | "state"
  | "subscription"
  | "target"

export interface ExpoTurboErrorContext {
  readonly action?: string
  readonly capabilityHash?: string
  readonly contentType?: string
  readonly documentId?: string
  readonly frameId?: string
  readonly location?: Readonly<{ column?: number; line?: number; offset?: number }>
  readonly payloadHash?: string
  readonly runtimeVersion?: string
  readonly target?: string
}

/** Base error whose context is deliberately limited to redacted protocol metadata. */
export class ExpoTurboError extends Error {
  readonly code: ExpoTurboErrorCode
  readonly context: Readonly<ExpoTurboErrorContext>

  constructor(
    code: ExpoTurboErrorCode,
    message: string,
    context: ExpoTurboErrorContext = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = new.target.name
    this.code = code
    this.context = Object.freeze({
      ...context,
      ...(context.location ? { location: Object.freeze({ ...context.location }) } : {}),
    })
  }
}

export class ParseError extends ExpoTurboError {
  constructor(message: string, context: ExpoTurboErrorContext = {}, options?: ErrorOptions) {
    super("parse", message, context, options)
  }
}

export class ContentTypeError extends ExpoTurboError {
  constructor(message: string, context: ExpoTurboErrorContext = {}, options?: ErrorOptions) {
    super("content_type", message, context, options)
  }
}

export class FrameMissingError extends ExpoTurboError {
  constructor(message: string, context: ExpoTurboErrorContext = {}, options?: ErrorOptions) {
    super("frame_missing", message, context, options)
  }
}

export class TargetError extends ExpoTurboError {
  constructor(message: string, context: ExpoTurboErrorContext = {}, options?: ErrorOptions) {
    super("target", message, context, options)
  }
}

export class ActionError extends ExpoTurboError {
  constructor(message: string, context: ExpoTurboErrorContext = {}, options?: ErrorOptions) {
    super("action", message, context, options)
  }
}

export class RegistryError extends ExpoTurboError {
  constructor(message: string, context: ExpoTurboErrorContext = {}, options?: ErrorOptions) {
    super("registry", message, context, options)
  }
}

export class PropsError extends ExpoTurboError {
  constructor(message: string, context: ExpoTurboErrorContext = {}, options?: ErrorOptions) {
    super("props", message, context, options)
  }
}

export class StateError extends ExpoTurboError {
  constructor(message: string, context: ExpoTurboErrorContext = {}, options?: ErrorOptions) {
    super("state", message, context, options)
  }
}

export class AuthError extends ExpoTurboError {
  constructor(message: string, context: ExpoTurboErrorContext = {}, options?: ErrorOptions) {
    super("auth", message, context, options)
  }
}

export class SubscriptionError extends ExpoTurboError {
  constructor(message: string, context: ExpoTurboErrorContext = {}, options?: ErrorOptions) {
    super("subscription", message, context, options)
  }
}
