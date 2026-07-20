import type { Unsubscribe, VisibilityAdapter } from "expo-turbo/adapters";

export const DEMO_ROOT_VISIBILITY_CONTAINER_ID = "demo-root-scroll";

export interface DemoVisibilityRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export type DemoMeasureInWindow = (
  listener: (x: number, y: number, width: number, height: number) => void,
) => void;

/**
 * Example-owned native virtual-list membership. Geometry alone is insufficient
 * for a buffered FlatList row: it must also be reported viewable by FlatList.
 */
export interface DemoViewabilityRegion {
  readonly id: string;
  dispose(): void;
  setItems(ids: readonly string[]): void;
  setVisibleItems(ids: readonly string[]): void;
}

export interface DemoFrameViewability {
  readonly itemId: string;
  readonly region: DemoViewabilityRegion;
}

interface DemoFrameVisibilityRecord {
  readonly clipIds: readonly string[];
  readonly measure: DemoMeasureInWindow;
  measureEpoch: number;
  rect: DemoVisibilityRect | undefined;
  visible: boolean;
  readonly viewability: DemoFrameViewability | undefined;
}

interface DemoVisibilityContainerRecord {
  readonly measure: DemoMeasureInWindow;
  measureEpoch: number;
  rect: DemoVisibilityRect | undefined;
}

interface DemoViewabilityRegionRecord {
  itemIds: readonly string[];
  readonly items: Set<string>;
  readonly region: DemoViewabilityRegion;
  readonly visibleItems: Set<string>;
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
    viewport.width > 0 &&
    viewport.height > 0 &&
    frame.width > 0 &&
    frame.height > 0 &&
    frame.x < viewport.x + viewport.width &&
    frame.x + frame.width > viewport.x &&
    frame.y < viewport.y + viewport.height &&
    frame.y + frame.height > viewport.y
  );
}

function intersect(
  first: DemoVisibilityRect,
  second: DemoVisibilityRect,
): DemoVisibilityRect | undefined {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const width = Math.min(first.x + first.width, second.x + second.width) - x;
  const height = Math.min(first.y + first.height, second.y + second.height) - y;
  return width > 0 && height > 0 ? Object.freeze({ height, width, x, y }) : undefined;
}

function clipIds(ids: readonly string[] | undefined): readonly string[] {
  const admitted = ids === undefined ? [DEMO_ROOT_VISIBILITY_CONTAINER_ID] : [...ids];
  if (
    admitted.length === 0 ||
    admitted.some((id) => typeof id !== "string" || id === "") ||
    new Set(admitted).size !== admitted.length
  ) {
    throw new TypeError("Demo Frame visibility clips require unique nonempty container ids");
  }
  return Object.freeze(admitted);
}

function viewabilityItemIds(ids: readonly string[]): readonly string[] {
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string" || id === "") ||
    new Set(ids).size !== ids.length
  ) {
    throw new TypeError("Demo FlatList viewability requires unique nonempty item ids");
  }
  return Object.freeze([...ids]);
}

/**
 * Example-owned visibility registry for Frame layout clipped by registered
 * root and nested ScrollView rectangles in one shared window coordinate space.
 */
export class DemoVisibilityRegistry implements VisibilityAdapter {
  private readonly containers = new Map<string, DemoVisibilityContainerRecord>();
  private disposed = false;
  private readonly frames = new Map<string, DemoFrameVisibilityRecord>();
  private readonly listeners = new Map<string, Set<(visible: boolean) => void>>();
  private readonly viewabilityRegionOwners = new WeakMap<
    DemoViewabilityRegion,
    readonly string[]
  >();
  private readonly viewabilityRegions = new Map<string, DemoViewabilityRegionRecord>();
  private viewport: DemoVisibilityRect | undefined;
  private viewportMeasureEpoch = 0;

  isVisible(id: string): boolean {
    return !this.disposed && (this.frames.get(id)?.visible ?? false);
  }

  subscribe(id: string, listener: (visible: boolean) => void): Unsubscribe {
    this.assertActive();
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

  register(
    id: string,
    measure: DemoMeasureInWindow,
    clips?: readonly string[],
    viewability?: DemoFrameViewability,
  ): Unsubscribe {
    this.assertActive();
    if (typeof id !== "string" || id === "") {
      throw new TypeError("Demo visibility registration requires a nonempty Frame id");
    }
    if (typeof measure !== "function") {
      throw new TypeError("Demo visibility registration requires a measurement callback");
    }
    const previous = this.frames.get(id);
    const record: DemoFrameVisibilityRecord = {
      clipIds: clipIds(clips),
      measure,
      measureEpoch: 0,
      rect: undefined,
      visible: false,
      viewability: this.assertViewability(viewability),
    };
    this.frames.set(id, record);
    if (previous?.visible) this.publish(id, false);
    this.measureFrame(id, record);
    return () => {
      if (this.frames.get(id) !== record) return;
      this.frames.delete(id);
      record.measureEpoch += 1;
      if (record.visible) this.publish(id, false);
    };
  }

  registerContainer(id: string, measure: DemoMeasureInWindow): Unsubscribe {
    this.assertActive();
    if (typeof id !== "string" || id === "") {
      throw new TypeError("Demo visibility containers require a nonempty id");
    }
    if (typeof measure !== "function") {
      throw new TypeError("Demo visibility containers require a measurement callback");
    }
    const previous = this.containers.get(id);
    if (previous) {
      previous.measureEpoch += 1;
      previous.rect = undefined;
    }
    const record: DemoVisibilityContainerRecord = { measure, measureEpoch: 0, rect: undefined };
    this.containers.set(id, record);
    this.invalidateFramesForContainer(id);
    this.measureContainer(id, record);
    return () => {
      if (this.containers.get(id) !== record) return;
      this.containers.delete(id);
      record.measureEpoch += 1;
      this.invalidateFramesForContainer(id);
    };
  }

  createViewabilityRegion(id: string, itemIds: readonly string[] = []): DemoViewabilityRegion {
    this.assertActive();
    if (typeof id !== "string" || id === "") {
      throw new TypeError("Demo FlatList viewability regions require a nonempty id");
    }
    const ownedItems = viewabilityItemIds(itemIds);
    let region!: DemoViewabilityRegion;
    region = Object.freeze({
      dispose: () => this.disposeViewabilityRegion(id, region),
      id,
      setItems: (itemIds: readonly string[]) => this.setViewabilityItems(id, region, itemIds),
      setVisibleItems: (itemIds: readonly string[]) =>
        this.setViewabilityVisibleItems(id, region, itemIds),
    });
    this.viewabilityRegionOwners.set(region, ownedItems);
    return region;
  }

  activateViewabilityRegion(region: DemoViewabilityRegion): Unsubscribe {
    this.assertActive();
    this.assertViewabilityRegion(region);
    const previous = this.viewabilityRegions.get(region.id);
    if (previous?.region === region) return () => {};
    if (previous) {
      this.viewabilityRegions.delete(region.id);
      this.invalidateFramesForViewabilityRegion(region.id);
    }
    const itemIds = this.viewabilityRegionOwners.get(region);
    if (!itemIds) throw new TypeError("Demo FlatList viewability regions must belong to this registry");
    this.viewabilityRegions.set(region.id, {
      itemIds,
      items: new Set<string>(itemIds),
      region,
      visibleItems: new Set<string>(),
    });
    this.updateFramesForViewabilityRegion(region);
    return () => this.disposeViewabilityRegion(region.id, region);
  }

  registerViewabilityRegion(id: string): DemoViewabilityRegion {
    const region = this.createViewabilityRegion(id);
    this.activateViewabilityRegion(region);
    return region;
  }

  setViewport(rect: DemoVisibilityRect): void {
    this.assertActive();
    this.viewportMeasureEpoch += 1;
    this.updateViewport(rect);
  }

  measureViewport(measure: DemoMeasureInWindow): void {
    this.assertActive();
    if (typeof measure !== "function") {
      throw new TypeError("Demo visibility viewport requires a measurement callback");
    }
    const measureEpoch = ++this.viewportMeasureEpoch;
    measure((x, y, width, height) => {
      if (this.disposed || measureEpoch !== this.viewportMeasureEpoch) return;
      this.updateViewport({ height, width, x, y });
    });
  }

  remeasure(id?: string): void {
    if (this.disposed) return;
    if (id !== undefined) {
      const record = this.frames.get(id);
      if (record) this.measureFrame(id, record);
      return;
    }
    for (const [frameId, record] of this.frames) this.measureFrame(frameId, record);
  }

  remeasureAll(): void {
    if (this.disposed) return;
    for (const [id, record] of this.containers) this.measureContainer(id, record);
    this.remeasure();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, record] of this.frames) {
      record.measureEpoch += 1;
      if (record.visible) this.publish(id, false);
    }
    for (const record of this.containers.values()) record.measureEpoch += 1;
    this.frames.clear();
    this.containers.clear();
    this.listeners.clear();
    this.viewabilityRegions.clear();
    this.viewport = undefined;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Demo visibility registry has been disposed");
  }

  private assertViewability(
    viewability: DemoFrameViewability | undefined,
  ): DemoFrameViewability | undefined {
    if (viewability === undefined) return undefined;
    if (
      !viewability ||
      typeof viewability !== "object" ||
      typeof viewability.itemId !== "string" ||
      viewability.itemId === "" ||
      !viewability.region ||
      typeof viewability.region !== "object" ||
      typeof viewability.region.id !== "string" ||
      viewability.region.id === "" ||
      !this.viewabilityRegionOwners.has(viewability.region)
    ) {
      throw new TypeError("Demo Frame viewability requires an owned FlatList region item");
    }
    return Object.freeze({ itemId: viewability.itemId, region: viewability.region });
  }

  private assertViewabilityRegion(region: DemoViewabilityRegion): void {
    if (
      !region ||
      typeof region !== "object" ||
      typeof region.id !== "string" ||
      region.id === "" ||
      !this.viewabilityRegionOwners.has(region)
    ) {
      throw new TypeError("Demo FlatList viewability regions must belong to this registry");
    }
  }

  private containerRect(id: string): DemoVisibilityRect | undefined {
    const container = this.containers.get(id);
    if (container) return container.rect;
    return id === DEMO_ROOT_VISIBILITY_CONTAINER_ID ? this.viewport : undefined;
  }

  private measureContainer(id: string, record: DemoVisibilityContainerRecord): void {
    const measureEpoch = ++record.measureEpoch;
    record.measure((x, y, width, height) => {
      if (
        this.disposed ||
        this.containers.get(id) !== record ||
        record.measureEpoch !== measureEpoch
      ) {
        return;
      }
      const rect = { height, width, x, y };
      record.rect = finiteRect(rect) ? Object.freeze(rect) : undefined;
      this.remeasureFramesForContainer(id);
    });
  }

  private measureFrame(id: string, record: DemoFrameVisibilityRecord): void {
    const measureEpoch = ++record.measureEpoch;
    record.measure((x, y, width, height) => {
      if (
        this.disposed ||
        this.frames.get(id) !== record ||
        record.measureEpoch !== measureEpoch
      ) {
        return;
      }
      const rect = { height, width, x, y };
      record.rect = finiteRect(rect) ? Object.freeze(rect) : undefined;
      this.updateFrameVisibility(id, record);
    });
  }

  private remeasureFramesForContainer(id: string): void {
    for (const [frameId, record] of this.frames) {
      if (record.clipIds.includes(id)) this.measureFrame(frameId, record);
    }
  }

  private invalidateFramesForContainer(id: string): void {
    for (const [frameId, record] of this.frames) {
      if (record.clipIds.includes(id)) this.publishIfChanged(frameId, record, false);
    }
  }

  private invalidateFramesForViewabilityRegion(id: string): void {
    for (const [frameId, record] of this.frames) {
      if (record.viewability?.region.id === id) this.publishIfChanged(frameId, record, false);
    }
  }

  private disposeViewabilityRegion(id: string, region: DemoViewabilityRegion): void {
    if (this.viewabilityRegions.get(id)?.region !== region) return;
    this.viewabilityRegions.delete(id);
    this.invalidateFramesForViewabilityRegion(id);
  }

  private setViewabilityItems(
    id: string,
    region: DemoViewabilityRegion,
    itemIds: readonly string[],
  ): void {
    const record = this.viewabilityRegions.get(id);
    if (record?.region !== region) return;
    const nextItems = viewabilityItemIds(itemIds);
    const changed =
      nextItems.length !== record.itemIds.length ||
      nextItems.some((itemId, index) => itemId !== record.itemIds[index]);
    if (!changed) return;
    record.itemIds = nextItems;
    record.items.clear();
    for (const itemId of nextItems) record.items.add(itemId);
    record.visibleItems.clear();
    this.updateFramesForViewabilityRegion(region);
  }

  private setViewabilityVisibleItems(
    id: string,
    region: DemoViewabilityRegion,
    itemIds: readonly string[],
  ): void {
    const record = this.viewabilityRegions.get(id);
    if (record?.region !== region) return;
    const nextItems = viewabilityItemIds(itemIds).filter((itemId) => record.items.has(itemId));
    if (
      nextItems.length === record.visibleItems.size &&
      nextItems.every((itemId) => record.visibleItems.has(itemId))
    ) {
      return;
    }
    record.visibleItems.clear();
    for (const itemId of nextItems) record.visibleItems.add(itemId);
    this.updateFramesForViewabilityRegion(region);
  }

  private updateFramesForViewabilityRegion(region: DemoViewabilityRegion): void {
    for (const [frameId, record] of this.frames) {
      if (record.viewability?.region === region) this.updateFrameVisibility(frameId, record);
    }
  }

  private updateFrameVisibility(id: string, record: DemoFrameVisibilityRecord): void {
    let viewport: DemoVisibilityRect | undefined;
    for (const clipId of record.clipIds) {
      const clip = this.containerRect(clipId);
      if (!clip || !finiteRect(clip)) {
        this.publishIfChanged(id, record, false);
        return;
      }
      viewport = viewport ? intersect(viewport, clip) : clip;
      if (!viewport) {
        this.publishIfChanged(id, record, false);
        return;
      }
    }
    if (!this.isViewable(record.viewability)) {
      this.publishIfChanged(id, record, false);
      return;
    }
    this.publishIfChanged(
      id,
      record,
      Boolean(record.rect && finiteRect(record.rect) && viewport && intersects(viewport, record.rect)),
    );
  }

  private isViewable(viewability: DemoFrameViewability | undefined): boolean {
    if (!viewability) return true;
    const region = this.viewabilityRegions.get(viewability.region.id);
    return (
      region?.region === viewability.region &&
      region.items.has(viewability.itemId) &&
      region.visibleItems.has(viewability.itemId)
    );
  }

  private updateViewport(rect: DemoVisibilityRect): void {
    if (!rect || typeof rect !== "object" || Array.isArray(rect) || !finiteRect(rect)) {
      throw new TypeError("Demo visibility viewport must be a finite rectangle");
    }
    this.viewport = Object.freeze({ ...rect });
    this.remeasureFramesForContainer(DEMO_ROOT_VISIBILITY_CONTAINER_ID);
  }

  private publishIfChanged(
    id: string,
    record: DemoFrameVisibilityRecord,
    visible: boolean,
  ): void {
    if (visible === record.visible) return;
    record.visible = visible;
    this.publish(id, visible);
  }

  private publish(id: string, visible: boolean): void {
    const listeners = this.listeners.get(id);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(visible);
  }
}
