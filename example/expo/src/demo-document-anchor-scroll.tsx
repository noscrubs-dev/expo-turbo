import type { DocumentAnchorScrollAdapter } from "expo-turbo/adapters";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import type { LayoutChangeEvent, View } from "react-native";

export interface DemoDocumentAnchorScrollContainer {
  readonly isAvailable: () => boolean;
  readonly measure?: (
    listener: (x: number, y: number, width: number, height: number) => void,
  ) => void;
  readonly reveal?: (container: DemoDocumentAnchorScrollContainer) => void;
  readonly scrollTo: (position: Readonly<{ x: number; y: number }>) => void;
}

export interface DemoDocumentAnchorScrollTarget {
  readonly getOffset: () => number | undefined;
  readonly measureOffset?: (relativeTo: View, listener: (offset: number) => void) => boolean;
}

interface DemoDocumentAnchorScrollTargetOwnership {
  readonly containerId: string | undefined;
  readonly target: DemoDocumentAnchorScrollTarget;
}

interface RegisteredDemoDocumentAnchorScrollTarget extends DemoDocumentAnchorScrollTarget {
  readonly setNativeTarget: (target: View | null) => void;
  readonly setOffset: (offset: number) => void;
}

/** Example-owned mapping from exact XML IDs to the root or one declared nested ScrollView. */
export class DemoDocumentAnchorScrollRegistry implements DocumentAnchorScrollAdapter {
  private container: DemoDocumentAnchorScrollContainer | undefined;
  private disposed = false;
  private documentContent: View | undefined;
  private documentContentOffset: number | undefined;
  private documentOffset: number | undefined;
  private readonly nestedContainers = new Map<string, DemoDocumentAnchorScrollContainer>();
  private pendingDeferredTarget: string | undefined;
  private readonly targets = new Map<string, DemoDocumentAnchorScrollTargetOwnership>();

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.container = undefined;
    this.documentContent = undefined;
    this.documentContentOffset = undefined;
    this.documentOffset = undefined;
    this.nestedContainers.clear();
    this.pendingDeferredTarget = undefined;
    this.targets.clear();
  }

  registerContainer(container: DemoDocumentAnchorScrollContainer): () => void {
    this.assertActive();
    if (!container || typeof container !== "object" || Array.isArray(container)) {
      throw new TypeError("Demo document anchor scrolling requires a root ScrollView container");
    }
    if (typeof container.isAvailable !== "function" || typeof container.scrollTo !== "function") {
      throw new TypeError("Demo document anchor scroll container is incomplete");
    }
    this.container = container;
    this.flushDeferredAnchor();
    return () => {
      if (this.container === container) this.container = undefined;
    };
  }

  registerNestedContainer(id: string, container: DemoDocumentAnchorScrollContainer): () => void {
    this.assertActive();
    if (
      !id ||
      id.trim() !== id ||
      !container ||
      typeof container !== "object" ||
      Array.isArray(container)
    ) {
      throw new TypeError("Demo nested anchor scrolling requires an ID and ScrollView container");
    }
    if (typeof container.isAvailable !== "function" || typeof container.scrollTo !== "function") {
      throw new TypeError("Demo nested anchor scroll container is incomplete");
    }
    if (container.measure !== undefined && typeof container.measure !== "function") {
      throw new TypeError("Demo nested anchor scroll container is incomplete");
    }
    const existing = this.nestedContainers.get(id);
    if (existing && existing !== container) {
      throw new Error(`Demo nested anchor scroll container ${id} is already registered`);
    }
    this.nestedContainers.set(id, container);
    this.flushDeferredAnchor();
    return () => {
      if (this.nestedContainers.get(id) === container) this.nestedContainers.delete(id);
    };
  }

  registerTarget(
    id: string,
    target: DemoDocumentAnchorScrollTarget,
    containerId?: string,
  ): () => void {
    this.assertActive();
    if (
      !id ||
      (containerId !== undefined && (!containerId || containerId.trim() !== containerId)) ||
      !target ||
      typeof target.getOffset !== "function"
    ) {
      throw new TypeError("Demo document anchor targets require an ID and offset reader");
    }
    const existing = this.targets.get(id);
    if (
      existing &&
      (existing.target !== target || existing.containerId !== containerId)
    ) {
      throw new Error(`Demo document anchor target ${id} is already registered`);
    }
    const ownership = existing ?? Object.freeze({ containerId, target });
    this.targets.set(id, ownership);
    this.flushDeferredAnchor();
    return () => {
      if (this.targets.get(id) === ownership) this.targets.delete(id);
    };
  }

  scrollTo(id: string, alignment: "start"): undefined {
    if (alignment !== "start") return undefined;
    this.scrollToTarget(id, false);
    return undefined;
  }

  /** Retains one exact Expo Go link request until its containers and target finish native layout. */
  requestDeferredAnchor(id: string): void {
    if (this.disposed || id.trim() === "") return;
    this.pendingDeferredTarget = id;
    this.flushDeferredAnchor();
  }

  cancelDeferredAnchor(): void {
    this.pendingDeferredTarget = undefined;
  }

  notifyDeferredAnchorLayout(): void {
    this.flushDeferredAnchor();
  }

  /** Re-applies one deferred target after the root ScrollView accepts its final content size. */
  confirmDeferredAnchorContentSize(): void {
    const targetId = this.pendingDeferredTarget;
    if (!targetId || !this.scrollToTarget(targetId)) return;
    this.pendingDeferredTarget = undefined;
  }

  setDocumentOffset(offset: number | undefined): void {
    if (this.disposed) return;
    if (offset !== undefined && !isNonNegativeFinite(offset)) {
      throw new TypeError("Demo document anchor offsets must be finite nonnegative values");
    }
    this.documentOffset = offset;
    this.flushDeferredAnchor();
  }

  setDocumentContentOffset(offset: number | undefined): void {
    if (this.disposed) return;
    if (offset !== undefined && !isNonNegativeFinite(offset)) {
      throw new TypeError("Demo document anchor offsets must be finite nonnegative values");
    }
    this.documentContentOffset = offset;
    this.flushDeferredAnchor();
  }

  setDocumentContent(content: View | undefined): void {
    if (this.disposed) return;
    this.documentContent = content;
    this.flushDeferredAnchor();
  }

  private flushDeferredAnchor(): void {
    const targetId = this.pendingDeferredTarget;
    if (targetId) this.scrollToTarget(targetId, true);
  }

  private scrollToTarget(id: string, revealNested = true): boolean {
    if (this.disposed) return false;
    const container = this.container;
    const ownership = this.targets.get(id);
    const target = ownership?.target;
    if (ownership?.containerId) {
      const nestedContainer = this.nestedContainers.get(ownership.containerId);
      const targetOffset = target?.getOffset();
      if (!nestedContainer?.isAvailable() || !isNonNegativeFinite(targetOffset)) return false;
      if (revealNested) {
        if (!container?.isAvailable() || !container.reveal || !nestedContainer.measure) return false;
        container.reveal(nestedContainer);
      }
      nestedContainer.scrollTo({ x: 0, y: targetOffset });
      return true;
    }
    if (
      !container?.isAvailable() ||
      !target ||
      this.documentOffset === undefined ||
      this.documentContentOffset === undefined
    ) {
      return false;
    }
    if (this.documentContent && target.measureOffset) {
      const measurementStarted = target.measureOffset(this.documentContent, (targetOffset) => {
        if (!isNonNegativeFinite(targetOffset)) return;
        container.scrollTo({ x: 0, y: targetOffset });
      });
      if (measurementStarted) return true;
    }
    const targetOffset = target.getOffset();
    if (!isNonNegativeFinite(targetOffset)) return false;
    container.scrollTo({
      x: 0,
      y: this.documentOffset + this.documentContentOffset + targetOffset,
    });
    return true;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Demo document anchor scroll registry is disposed");
  }
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const DemoDocumentAnchorScrollContext = createContext<DemoDocumentAnchorScrollRegistry | undefined>(
  undefined,
);
const DemoDocumentAnchorContainerContext = createContext<string | undefined>(undefined);

export function DemoDocumentAnchorScrollProvider({
  anchorScroll,
  children,
}: Readonly<{ anchorScroll: DemoDocumentAnchorScrollRegistry; children?: ReactNode }>) {
  return (
    <DemoDocumentAnchorScrollContext.Provider value={anchorScroll}>
      {children}
    </DemoDocumentAnchorScrollContext.Provider>
  );
}

export function DemoDocumentAnchorContainerProvider({
  children,
  id,
}: Readonly<{ children?: ReactNode; id: string }>) {
  return (
    <DemoDocumentAnchorContainerContext.Provider value={id}>
      {children}
    </DemoDocumentAnchorContainerContext.Provider>
  );
}

export function useDemoDocumentAnchorScroll(): DemoDocumentAnchorScrollRegistry {
  const anchorScroll = useContext(DemoDocumentAnchorScrollContext);
  if (!anchorScroll) throw new Error("The Expo Turbo demo document anchor scroll is not configured");
  return anchorScroll;
}

export function useDemoDocumentAnchorScrollContent(): Readonly<{
  setNativeContent(node: View | null): void;
  onLayout(event: LayoutChangeEvent): void;
}> {
  const anchorScroll = useContext(DemoDocumentAnchorScrollContext);
  useLayoutEffect(
    () => () => anchorScroll?.setDocumentContentOffset(undefined),
    [anchorScroll],
  );
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => anchorScroll?.setDocumentContentOffset(event.nativeEvent.layout.y),
    [anchorScroll],
  );
  const setNativeContent = useCallback(
    (node: View | null) => anchorScroll?.setDocumentContent(node ?? undefined),
    [anchorScroll],
  );
  return useMemo(
    () => Object.freeze({ onLayout, setNativeContent }),
    [onLayout, setNativeContent],
  );
}

export function useDemoDocumentAnchorTarget(id: string): Readonly<{
  setNativeTarget(node: View | null): void;
  onLayout(event: LayoutChangeEvent): void;
}> {
  const anchorScroll = useDemoDocumentAnchorScroll();
  const containerId = useContext(DemoDocumentAnchorContainerContext);
  const [target] = useState<RegisteredDemoDocumentAnchorScrollTarget>(() => {
    let offset: number | undefined;
    let nativeTarget: View | null = null;
    return Object.freeze({
      getOffset: () => offset,
      measureOffset: (relativeTo: View, listener: (offset: number) => void) => {
        if (!nativeTarget || typeof nativeTarget.measureLayout !== "function") return false;
        nativeTarget.measureLayout(
          relativeTo,
          (_x, y) => listener(y),
          () => undefined,
        );
        return true;
      },
      setNativeTarget: (node: View | null) => {
        nativeTarget = node;
      },
      setOffset: (nextOffset: number) => {
        offset = nextOffset;
      },
    });
  });
  useLayoutEffect(
    () => anchorScroll.registerTarget(id, target, containerId),
    [anchorScroll, containerId, id, target],
  );
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      target.setOffset(event.nativeEvent.layout.y);
      anchorScroll.notifyDeferredAnchorLayout();
    },
    [anchorScroll, target],
  );
  const setNativeTarget = useCallback(
    (node: View | null) => target.setNativeTarget(node),
    [target],
  );
  return useMemo(
    () => Object.freeze({ onLayout, setNativeTarget }),
    [onLayout, setNativeTarget],
  );
}
