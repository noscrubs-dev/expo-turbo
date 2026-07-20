import type { FrameRenderMethod } from "./frame-lifecycle"

const frameLoadRenderMethods = new WeakMap<object, FrameRenderMethod>()

/** @internal Captures a controller-selected Frame render mode without widening FrameLoadOptions. */
export function withFrameLoadRenderMethod<Options extends object>(
  options: Options,
  renderMethod: FrameRenderMethod,
): Options {
  frameLoadRenderMethods.set(options, renderMethod)
  return options
}

/** @internal Reads the mode captured by the trusted Frame controller. */
export function frameLoadRenderMethod(options: object): FrameRenderMethod {
  return frameLoadRenderMethods.get(options) ?? "replace"
}
