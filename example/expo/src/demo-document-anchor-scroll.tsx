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
import type { LayoutChangeEvent } from "react-native";

export interface DemoDocumentAnchorScrollContainer {
  readonly isAvailable: () => boolean;
  readonly scrollTo: (position: Readonly<{ x: number; y: number }>) => void;
}

export interface DemoDocumentAnchorScrollTarget {
  readonly getOffset: () => number | undefined;
}

interface RegisteredDemoDocumentAnchorScrollTarget extends DemoDocumentAnchorScrollTarget {
  readonly setOffset: (offset: number) => void;
}

/** Example-owned, root-only mapping from exact XML IDs to ScrollView offsets. */
export class DemoDocumentAnchorScrollRegistry implements DocumentAnchorScrollAdapter {
  private container: DemoDocumentAnchorScrollContainer | undefined;
  private disposed = false;
  private documentContentOffset: number | undefined;
  private documentOffset: number | undefined;
  private pendingInitialTarget: string | undefined;
  private readonly targets = new Map<string, DemoDocumentAnchorScrollTarget>();

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.container = undefined;
    this.documentContentOffset = undefined;
    this.documentOffset = undefined;
    this.pendingInitialTarget = undefined;
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
    this.flushInitialAnchor();
    return () => {
      if (this.container === container) this.container = undefined;
    };
  }

  registerTarget(id: string, target: DemoDocumentAnchorScrollTarget): () => void {
    this.assertActive();
    if (!id || !target || typeof target.getOffset !== "function") {
      throw new TypeError("Demo document anchor targets require an ID and offset reader");
    }
    const existing = this.targets.get(id);
    if (existing && existing !== target) {
      throw new Error(`Demo document anchor target ${id} is already registered`);
    }
    this.targets.set(id, target);
    this.flushInitialAnchor();
    return () => {
      if (this.targets.get(id) === target) this.targets.delete(id);
    };
  }

  scrollTo(id: string, alignment: "start"): undefined {
    if (alignment !== "start") return undefined;
    this.scrollToTarget(id);
    return undefined;
  }

  /** Retains one exact cold-link request until the root and target finish native layout. */
  requestInitialAnchor(id: string): void {
    if (this.disposed || id.trim() === "") return;
    this.pendingInitialTarget = id;
    this.flushInitialAnchor();
  }

  notifyInitialAnchorLayout(): void {
    this.flushInitialAnchor();
  }

  setDocumentOffset(offset: number | undefined): void {
    if (this.disposed) return;
    if (offset !== undefined && !isNonNegativeFinite(offset)) {
      throw new TypeError("Demo document anchor offsets must be finite nonnegative values");
    }
    this.documentOffset = offset;
    this.flushInitialAnchor();
  }

  setDocumentContentOffset(offset: number | undefined): void {
    if (this.disposed) return;
    if (offset !== undefined && !isNonNegativeFinite(offset)) {
      throw new TypeError("Demo document anchor offsets must be finite nonnegative values");
    }
    this.documentContentOffset = offset;
    this.flushInitialAnchor();
  }

  private flushInitialAnchor(): void {
    const targetId = this.pendingInitialTarget;
    if (!targetId || !this.scrollToTarget(targetId)) return;
    this.pendingInitialTarget = undefined;
  }

  private scrollToTarget(id: string): boolean {
    if (this.disposed) return false;
    const container = this.container;
    const target = this.targets.get(id);
    if (
      !container?.isAvailable() ||
      !target ||
      this.documentOffset === undefined ||
      this.documentContentOffset === undefined
    ) {
      return false;
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

export function useDemoDocumentAnchorScrollContent(): Readonly<{
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
  return useMemo(() => Object.freeze({ onLayout }), [onLayout]);
}

export function useDemoDocumentAnchorTarget(id: string): Readonly<{
  onLayout(event: LayoutChangeEvent): void;
}> {
  const anchorScroll = useContext(DemoDocumentAnchorScrollContext);
  if (!anchorScroll) throw new Error("The Expo Turbo demo document anchor scroll is not configured");
  const [target] = useState<RegisteredDemoDocumentAnchorScrollTarget>(() => {
    let offset: number | undefined;
    return Object.freeze({
      getOffset: () => offset,
      setOffset: (nextOffset: number) => {
        offset = nextOffset;
      },
    });
  });
  useLayoutEffect(() => anchorScroll.registerTarget(id, target), [anchorScroll, id, target]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      target.setOffset(event.nativeEvent.layout.y);
      anchorScroll.notifyInitialAnchorLayout();
    },
    [anchorScroll, target],
  );
  return useMemo(() => Object.freeze({ onLayout }), [onLayout]);
}
