import type { DocumentRefreshScrollAdapter } from "expo-turbo/adapters";

export interface DemoDocumentRefreshScrollContainer {
  readonly isAvailable: () => boolean;
  readonly scrollToTop: () => void;
}

/** Example-owned reset for the gallery's one owning-document ScrollView. */
export class DemoDocumentRefreshScrollRegistry implements DocumentRefreshScrollAdapter {
  private container: DemoDocumentRefreshScrollContainer | undefined;
  private disposed = false;

  canReset(): boolean {
    return !this.disposed && Boolean(this.container?.isAvailable());
  }

  registerContainer(container: DemoDocumentRefreshScrollContainer): () => void {
    if (this.disposed) throw new Error("Demo document refresh scroll registry is disposed");
    if (!container || typeof container !== "object" || Array.isArray(container)) {
      throw new TypeError("Demo document refresh scroll requires a root ScrollView container");
    }
    if (typeof container.isAvailable !== "function" || typeof container.scrollToTop !== "function") {
      throw new TypeError("Demo document refresh scroll container is incomplete");
    }
    this.container = container;
    return () => {
      if (this.container === container) this.container = undefined;
    };
  }

  reset(): void {
    if (!this.canReset()) return;
    this.container?.scrollToTop();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.container = undefined;
  }
}
