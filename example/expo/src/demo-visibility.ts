import type { Unsubscribe, VisibilityAdapter } from "expo-turbo/adapters";

export interface DemoVisibilityRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export type DemoMeasureInWindow = (
  listener: (x: number, y: number, width: number, height: number) => void,
) => void;

interface DemoFrameVisibilityRecord {
  readonly measure: DemoMeasureInWindow;
  measureEpoch: number;
  visible: boolean;
}

function finiteRect(rect: DemoVisibilityRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}

function intersects(viewport: DemoVisibilityRect, frame: DemoVisibilityRect): boolean {
  return (
    frame.width > 0 &&
    frame.height > 0 &&
    frame.x < viewport.x + viewport.width &&
    frame.x + frame.width > viewport.x &&
    frame.y < viewport.y + viewport.height &&
    frame.y + frame.height > viewport.y
  );
}

/** Example-owned visibility registry for ordinary layout inside one root ScrollView. */
export class DemoVisibilityRegistry implements VisibilityAdapter {
  private readonly frames = new Map<string, DemoFrameVisibilityRecord>();
  private readonly listeners = new Map<string, Set<(visible: boolean) => void>>();
  private viewportMeasureEpoch = 0;
  private viewport: DemoVisibilityRect | undefined;

  isVisible(id: string): boolean {
    return this.frames.get(id)?.visible ?? false;
  }

  subscribe(id: string, listener: (visible: boolean) => void): Unsubscribe {
    if (typeof id !== "string" || id === "") {
      throw new TypeError("Demo visibility subscriptions require a nonempty Frame id");
    }
    if (typeof listener !== "function") {
      throw new TypeError("Demo visibility subscriptions require a listener");
    }
    const listeners = this.listeners.get(id) ?? new Set<(visible: boolean) => void>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }

  register(id: string, measure: DemoMeasureInWindow): Unsubscribe {
    if (typeof id !== "string" || id === "") {
      throw new TypeError("Demo visibility registration requires a nonempty Frame id");
    }
    if (typeof measure !== "function") {
      throw new TypeError("Demo visibility registration requires a measurement callback");
    }
    const previous = this.frames.get(id);
    const record: DemoFrameVisibilityRecord = { measure, measureEpoch: 0, visible: false };
    this.frames.set(id, record);
    if (previous?.visible) this.publish(id, false);
    this.measure(id, record);
    return () => {
      if (this.frames.get(id) !== record) return;
      this.frames.delete(id);
      record.measureEpoch += 1;
      if (record.visible) this.publish(id, false);
    };
  }

  setViewport(rect: DemoVisibilityRect): void {
    this.viewportMeasureEpoch += 1;
    this.updateViewport(rect);
  }

  measureViewport(measure: DemoMeasureInWindow): void {
    if (typeof measure !== "function") {
      throw new TypeError("Demo visibility viewport requires a measurement callback");
    }
    const measureEpoch = ++this.viewportMeasureEpoch;
    measure((x, y, width, height) => {
      if (measureEpoch !== this.viewportMeasureEpoch) return;
      this.updateViewport({ height, width, x, y });
    });
  }

  remeasure(id?: string): void {
    if (id !== undefined) {
      const record = this.frames.get(id);
      if (record) this.measure(id, record);
      return;
    }
    for (const [frameId, record] of this.frames) this.measure(frameId, record);
  }

  private measure(id: string, record: DemoFrameVisibilityRecord): void {
    const measureEpoch = ++record.measureEpoch;
    record.measure((x, y, width, height) => {
      if (this.frames.get(id) !== record || record.measureEpoch !== measureEpoch) return;
      const frame = { height, width, x, y };
      const visible = Boolean(this.viewport && finiteRect(frame) && intersects(this.viewport, frame));
      if (visible === record.visible) return;
      record.visible = visible;
      this.publish(id, visible);
    });
  }

  private updateViewport(rect: DemoVisibilityRect): void {
    if (!rect || typeof rect !== "object" || Array.isArray(rect) || !finiteRect(rect)) {
      throw new TypeError("Demo visibility viewport must be a finite rectangle");
    }
    this.viewport = Object.freeze({ ...rect });
    this.remeasure();
  }

  private publish(id: string, visible: boolean): void {
    const listeners = this.listeners.get(id);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(visible);
  }
}
