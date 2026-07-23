import type { AutofocusAdapter, FocusAdapter } from "expo-turbo/adapters";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useMemo,
} from "react";

export interface DemoFocusHandle {
  blur(): void;
  focus(): void;
}

export class DemoFocusRegistry implements AutofocusAdapter, FocusAdapter {
  private disposed = false;
  private focusedId: string | undefined;
  private focusRevision = 0;
  private readonly eventTokens = new Map<string, object>();
  private readonly handles = new Map<string, DemoFocusHandle>();
  private readonly replayFocus = new Map<
    string,
    Readonly<{ eventToken: object; handle: DemoFocusHandle; revision: number }>
  >();

  blur(id: string): void {
    this.assertActive();
    const handle = this.handles.get(id);
    if (!handle) throw new Error(`No active demo focus handle is registered for ${id}`);
    const revision = this.focusRevision;
    handle.blur();
    if (
      this.handles.get(id) === handle &&
      this.focusRevision === revision &&
      this.focusedId === id
    ) {
      this.focusedId = undefined;
      this.focusRevision += 1;
    }
  }

  canFocus(id: string): boolean {
    this.assertActive();
    return this.handles.has(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.focusedId = undefined;
    this.focusRevision += 1;
    this.eventTokens.clear();
    this.handles.clear();
    this.replayFocus.clear();
  }

  focus(id: string): void {
    this.assertActive();
    const handle = this.handles.get(id);
    if (!handle) throw new Error(`No active demo focus handle is registered for ${id}`);
    const revision = this.focusRevision;
    handle.focus();
    if (this.handles.get(id) === handle && this.focusRevision === revision) {
      this.focusedId = id;
      this.focusRevision += 1;
    }
  }

  getFocusedId(): string | undefined {
    return this.focusedId;
  }

  getMorphFocusedId(): string | undefined {
    return this.focusedId;
  }

  handleBlur(id: string, eventToken: object): void {
    this.assertActive();
    if (this.eventTokens.get(id) !== eventToken) return;
    if (this.focusedId === id) {
      this.focusedId = undefined;
      this.focusRevision += 1;
    }
  }

  handleFocus(id: string, eventToken: object): void {
    this.assertActive();
    if (this.eventTokens.get(id) !== eventToken) return;
    this.focusedId = id;
    this.focusRevision += 1;
  }

  register(id: string, handle: DemoFocusHandle, eventToken: object = handle): () => void {
    this.assertActive();
    if (
      !id ||
      !handle ||
      typeof handle.focus !== "function" ||
      typeof handle.blur !== "function" ||
      !eventToken ||
      (typeof eventToken !== "object" && typeof eventToken !== "function")
    ) {
      throw new Error("Demo focus registrations require an ID and focusable handle");
    }
    if (this.handles.has(id)) throw new Error(`Demo focus handle ${id} is already registered`);
    const replay = this.replayFocus.get(id);
    this.replayFocus.delete(id);
    this.handles.set(id, handle);
    this.eventTokens.set(id, eventToken);
    if (
      replay?.handle === handle &&
      replay.eventToken === eventToken &&
      replay.revision === this.focusRevision &&
      this.focusedId === undefined
    ) {
      this.focusedId = id;
      this.focusRevision += 1;
    }
    return () => {
      if (this.handles.get(id) !== handle) return;
      this.handles.delete(id);
      this.eventTokens.delete(id);
      if (this.focusedId === id) {
        this.focusedId = undefined;
        this.focusRevision += 1;
        const pending = Object.freeze({
          eventToken,
          handle,
          revision: this.focusRevision,
        });
        this.replayFocus.set(id, pending);
        queueMicrotask(() => {
          if (this.replayFocus.get(id) === pending) this.replayFocus.delete(id);
        });
      }
    };
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Demo focus registry has been disposed");
  }
}

const DemoFocusContext = createContext<DemoFocusRegistry | undefined>(undefined);

export function DemoFocusProvider({
  children,
  focus,
}: Readonly<{ children?: ReactNode; focus: DemoFocusRegistry }>) {
  return <DemoFocusContext.Provider value={focus}>{children}</DemoFocusContext.Provider>;
}

export function useDemoFocusHandle(
  nodeKey: string,
  ref: RefObject<DemoFocusHandle | null>,
): Readonly<{ onBlur(): void; onFocus(): void }> {
  const focus = useContext(DemoFocusContext);
  if (!focus) throw new Error("The Expo Turbo demo focus registry is not configured");
  const eventToken = useMemo(() => Object.freeze({}), []);
  const handle = useMemo<DemoFocusHandle>(
    () => ({
      blur: () => {
        if (!ref.current) throw new Error(`Demo focus handle ${nodeKey} is not mounted`);
        ref.current.blur();
      },
      focus: () => {
        if (!ref.current) throw new Error(`Demo focus handle ${nodeKey} is not mounted`);
        ref.current.focus();
      },
    }),
    [nodeKey, ref],
  );
  useLayoutEffect(
    () => focus.register(nodeKey, handle, eventToken),
    [eventToken, focus, handle, nodeKey],
  );
  return useMemo(
    () =>
      Object.freeze({
        onBlur: () => focus.handleBlur(nodeKey, eventToken),
        onFocus: () => focus.handleFocus(nodeKey, eventToken),
      }),
    [eventToken, focus, nodeKey],
  );
}
