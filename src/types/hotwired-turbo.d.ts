declare module "@hotwired/turbo" {
  export interface TurboSession {
    stop(): void
  }

  export const session: TurboSession
  export function start(): void
  export function renderStreamMessage(message: string): void

  const Turbo: {
    readonly renderStreamMessage: typeof renderStreamMessage
    readonly session: TurboSession
    readonly start: typeof start
  }

  export default Turbo
}
