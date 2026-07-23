declare module "@hotwired/turbo" {
  export interface TurboSession {
    stop(): void
  }

  export const session: TurboSession
  export function renderStreamMessage(message: string): void

  const Turbo: {
    readonly renderStreamMessage: typeof renderStreamMessage
    readonly session: TurboSession
  }

  export default Turbo
}
