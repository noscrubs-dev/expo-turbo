import type { NavigationAdapter, VisitAction } from "expo-turbo/adapters";
import {
  type DocumentHistoryEntry,
  type DocumentHistoryHostAdapter,
  type DocumentHistoryState,
  type DocumentHistoryTraversalSource,
  type DocumentHistoryTraversalUnsubscribe,
  type DocumentHistoryWriteMethod,
  StateError,
} from "expo-turbo/core";

import {
  DEMO_ROUTER_PATH_PARAM,
  decodeDemoRouterDocumentPath,
  encodeDemoRouterDocumentPath,
} from "./demo-router-path";

export const DEMO_ROUTER_ROUTE_NAME = "[...expoTurboPath]";

export const DEMO_ROUTER_HISTORY_PARAMS = Object.freeze({
  restorationIdentifier: "__expo_turbo_restoration_identifier",
  restorationIndex: "__expo_turbo_restoration_index",
  url: "__expo_turbo_document_url",
});

const DEMO_ROUTER_HISTORY_PARAM_NAMES = new Set<string>(
  [DEMO_ROUTER_PATH_PARAM, ...Object.values(DEMO_ROUTER_HISTORY_PARAMS)],
);
const documentUrlEncodingPrefix = "v1~";

export interface DemoRouterRoute {
  readonly key: string;
  readonly name: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly path?: string;
}

export interface DemoRouterState {
  readonly key: string;
  readonly index: number;
  readonly preloadedRoutes: readonly DemoRouterRoute[];
  readonly routeNames: readonly string[];
  readonly routes: readonly DemoRouterRoute[];
  readonly stale: false;
  readonly type: "stack";
}

export interface DemoRouterNavigation {
  addListener(event: "state", listener: () => void): () => void;
  canGoBack(): boolean;
  getState(): DemoRouterState | undefined;
  goBack(): void;
  push(name: string, params: Readonly<Record<string, unknown>>): void;
  reset(state: DemoRouterState): void;
  setParams(params: Readonly<Record<string, unknown>>): void;
}

export interface DemoRouterHistoryBridgeOptions {
  readonly currentEntry: () => DocumentHistoryEntry | undefined;
  readonly openExternal: (url: string) => Promise<void> | void;
}

interface DemoRouterAttachment {
  active: boolean;
  readonly navigation: DemoRouterNavigation;
  readonly routeKey: string;
  unsubscribe: (() => void) | undefined;
}

type DemoRouterErrorListener = (error: Error | undefined) => void;

function paramsRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StateError("Demo Router history route params are invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}

function normalizedUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return undefined;
  }
  return url.toString();
}

function canonicalDocumentUrl(value: unknown): string | undefined {
  const url = normalizedUrl(value);
  return url === value ? url : undefined;
}

function encodeDocumentUrl(value: string): string {
  const percentEncoded = encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${documentUrlEncodingPrefix}${percentEncoded.replaceAll("~", "~~").replaceAll("%", "~")}`;
}

function decodeDocumentUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(documentUrlEncodingPrefix)) {
    return undefined;
  }
  let percentEncoded = "";
  for (let index = documentUrlEncodingPrefix.length; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "~") {
      percentEncoded += character;
      continue;
    }
    const next = value[index + 1];
    if (next === "~") {
      percentEncoded += "~";
      index += 1;
      continue;
    }
    const encodedByte = value.slice(index + 1, index + 3);
    if (!/^[\dA-F]{2}$/i.test(encodedByte)) return undefined;
    percentEncoded += `%${encodedByte}`;
    index += 2;
  }
  try {
    return decodeURIComponent(percentEncoded);
  } catch {
    return undefined;
  }
}

export function decodeDemoRouterHistoryEntry(
  value: unknown,
): DocumentHistoryEntry | undefined {
  let params: Readonly<Record<string, unknown>>;
  try {
    params = paramsRecord(value);
  } catch {
    return undefined;
  }
  const restorationIdentifier = params[DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier];
  const restorationIndex = params[DEMO_ROUTER_HISTORY_PARAMS.restorationIndex];
  const url = canonicalDocumentUrl(
    decodeDocumentUrl(params[DEMO_ROUTER_HISTORY_PARAMS.url]),
  );
  if (
    typeof restorationIdentifier !== "string" ||
    restorationIdentifier.trim() === "" ||
    typeof restorationIndex !== "string" ||
    !/^(0|[1-9]\d*)$/.test(restorationIndex) ||
    !url
  ) {
    return undefined;
  }
  const numericIndex = Number(restorationIndex);
  if (!Number.isSafeInteger(numericIndex)) return undefined;
  return Object.freeze({
    restorationIdentifier,
    restorationIndex: numericIndex,
    url,
  });
}

export function encodeDemoRouterHistoryEntry(
  entry: DocumentHistoryEntry,
): Readonly<Record<string, string>> {
  const url = canonicalDocumentUrl(entry.url);
  if (!url) throw new StateError("Demo Router history entry URL is invalid");
  return Object.freeze({
    [DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier]: entry.restorationIdentifier,
    [DEMO_ROUTER_HISTORY_PARAMS.restorationIndex]: String(entry.restorationIndex),
    [DEMO_ROUTER_HISTORY_PARAMS.url]: encodeDocumentUrl(url),
  });
}

function entriesEqual(
  left: DocumentHistoryEntry | undefined,
  right: DocumentHistoryEntry | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.restorationIdentifier === right.restorationIdentifier &&
      left.restorationIndex === right.restorationIndex &&
      left.url === right.url)
  );
}

function routeState(navigation: DemoRouterNavigation): Readonly<{
  route: DemoRouterRoute;
  state: DemoRouterState;
}> {
  try {
    const state = navigation.getState();
    if (
      !state ||
      !Array.isArray(state.routes) ||
      !Array.isArray(state.preloadedRoutes) ||
      !Array.isArray(state.routeNames) ||
      state.stale !== false ||
      state.type !== "stack" ||
      typeof state.key !== "string" ||
      state.key.trim() === "" ||
      !Number.isSafeInteger(state.index) ||
      state.index < 0 ||
      state.index >= state.routes.length
    ) {
      throw new StateError("Demo Router history requires a focused stack route");
    }
    const routeKeys = new Set<string>();
    const routeNames = new Set<string>();
    for (const name of state.routeNames) {
      if (typeof name !== "string" || name.trim() === "" || routeNames.has(name)) {
        throw new StateError("Demo Router history state is unavailable");
      }
      routeNames.add(name);
    }
    for (const candidate of [...state.routes, ...state.preloadedRoutes]) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        typeof candidate.key !== "string" ||
        candidate.key.trim() === "" ||
        routeKeys.has(candidate.key) ||
        typeof candidate.name !== "string" ||
        !routeNames.has(candidate.name)
      ) {
        throw new StateError("Demo Router history state is unavailable");
      }
      routeKeys.add(candidate.key);
      paramsRecord(candidate.params);
    }
    const route = state.routes[state.index];
    if (!route) throw new StateError("Demo Router history requires a valid focused route");
    return Object.freeze({ route, state });
  } catch {
    throw new StateError("Demo Router history state is unavailable");
  }
}

function unmanagedParams(route: DemoRouterRoute): Readonly<Record<string, unknown>> {
  const params = paramsRecord(route.params);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(params).filter(
        ([key]) => !DEMO_ROUTER_HISTORY_PARAM_NAMES.has(key),
      ),
    ),
  );
}

function routeDocumentPath(route: DemoRouterRoute) {
  const params = paramsRecord(route.params);
  return decodeDemoRouterDocumentPath(params[DEMO_ROUTER_PATH_PARAM]);
}

function managedEntry(route: DemoRouterRoute): DocumentHistoryEntry | undefined {
  const entry = decodeDemoRouterHistoryEntry(route.params);
  if (!entry) return undefined;
  const path = routeDocumentPath(route);
  let entrySegments: readonly string[];
  try {
    entrySegments = encodeDemoRouterDocumentPath(entry.url);
  } catch {
    throw new StateError("Demo Router history metadata does not match its canonical path");
  }
  if (
    entrySegments.length !== path.segments.length ||
    entrySegments.some((segment, index) => segment !== path.segments[index])
  ) {
    throw new StateError("Demo Router history metadata does not match its canonical path");
  }
  return entry;
}

function routeDocumentUrl(route: DemoRouterRoute): string {
  return managedEntry(route)?.url ?? routeDocumentPath(route).url;
}

function sameStackState(left: DemoRouterState, right: DemoRouterState): boolean {
  return sameNavigationValue(left, right);
}

function stackStateRecord(state: DemoRouterState): Readonly<Record<string, unknown>> {
  return state as DemoRouterState & Readonly<Record<string, unknown>>;
}

function expectedPushState(
  before: DemoRouterState,
  pushed: DemoRouterRoute,
  routeName: string,
  params: Readonly<Record<string, unknown>>,
): DemoRouterState {
  const reused = before.preloadedRoutes.find((route) => route.name === routeName);
  if (reused ? pushed.key !== reused.key : !pushed.key.startsWith(`${routeName}-`)) {
    throw new StateError("Demo Router history push did not commit exactly");
  }
  if (
    !reused &&
    [...before.routes, ...before.preloadedRoutes].some((route) => route.key === pushed.key)
  ) {
    throw new StateError("Demo Router history push did not commit exactly");
  }
  const nextRoute = reused
    ? Object.freeze({ ...reused, path: reused.path, params })
    : Object.freeze({ key: pushed.key, name: routeName, path: undefined, params });
  const routes = Object.freeze([...before.routes, nextRoute]);
  const expected: Record<string, unknown> = {
    ...stackStateRecord(before),
    index: routes.length - 1,
    routes,
  };
  expected.preloadedRoutes = Object.freeze(
    before.preloadedRoutes.filter((route) => route.key !== nextRoute.key),
  );
  return Object.freeze(expected) as unknown as DemoRouterState;
}

function expectedReplaceState(
  before: DemoRouterState,
  params: Readonly<Record<string, unknown>>,
): DemoRouterState {
  const routes = Object.freeze(
    before.routes.map((route, index) =>
      index === before.index
        ? Object.freeze({
            ...route,
            params: Object.freeze({ ...paramsRecord(route.params), ...params }),
          })
        : route,
    ),
  );
  return Object.freeze({ ...stackStateRecord(before), routes }) as unknown as DemoRouterState;
}

function sameNavigationValue(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, WeakSet<object>>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }
  const compared = seen.get(left);
  if (compared?.has(right)) return true;
  if (compared) compared.add(right);
  else seen.set(left, new WeakSet([right]));
  try {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.hasOwn(right, key) &&
          sameNavigationValue(
            (left as Record<string, unknown>)[key],
            (right as Record<string, unknown>)[key],
            seen,
          ),
      )
    );
  } catch {
    return false;
  }
}

function assertUndefinedResult(result: unknown, message: string): void {
  if (result === undefined) return;
  if ((typeof result === "object" && result !== null) || typeof result === "function") {
    try {
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // The safe bridge error below is the only exposed host failure.
    }
  }
  throw new StateError(message);
}

function mergedParams(
  route: DemoRouterRoute,
  entry: DocumentHistoryEntry,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...unmanagedParams(route),
    [DEMO_ROUTER_PATH_PARAM]: encodeDemoRouterDocumentPath(entry.url),
    ...encodeDemoRouterHistoryEntry(entry),
  });
}

/** Example-owned synchronous Expo Router history and traversal bridge. */
export class DemoRouterHistoryBridge
  implements DocumentHistoryHostAdapter, DocumentHistoryTraversalSource, NavigationAdapter
{
  private attachment: DemoRouterAttachment | undefined;
  private readonly currentEntry: () => DocumentHistoryEntry | undefined;
  private error: Error | undefined;
  private readonly errorListeners = new Set<DemoRouterErrorListener>();
  private emittedEntry: DocumentHistoryEntry | undefined;
  private malformedRouteKey: string | undefined;
  private readonly openExternalUrl: (url: string) => Promise<void> | void;
  private pendingEntry: DocumentHistoryEntry | undefined;
  private terminal = false;
  private readonly traversalListeners = new Set<(entry: DocumentHistoryEntry) => void>();
  private writeActive = false;

  constructor(options: DemoRouterHistoryBridgeOptions) {
    this.currentEntry = options.currentEntry;
    this.openExternalUrl = options.openExternal;
  }

  attach(navigation: DemoRouterNavigation, routeKey: string): DocumentHistoryTraversalUnsubscribe {
    if (this.terminal) throw new StateError("Demo Router history failed closed");
    if (typeof routeKey !== "string" || routeKey.trim() === "") {
      throw new StateError("Demo Router history attachment requires a route key");
    }
    const { route } = routeState(navigation);
    if (route.key !== routeKey) {
      throw new StateError("Demo Router history attachment must own the focused route");
    }
    if (route.name !== DEMO_ROUTER_ROUTE_NAME) {
      throw new StateError("Demo Router history attachment requires its canonical route");
    }
    routeDocumentUrl(route);

    this.detach(this.attachment);
    const attachment: DemoRouterAttachment = {
      active: true,
      navigation,
      routeKey,
      unsubscribe: undefined,
    };
    this.attachment = attachment;
    this.malformedRouteKey = undefined;
    let unsubscribe: unknown;
    try {
      unsubscribe = navigation.addListener("state", () => this.handleState(attachment));
    } catch {
      this.attachment = undefined;
      attachment.active = false;
      throw new StateError("Demo Router history state subscription failed");
    }
    if (typeof unsubscribe !== "function") {
      this.attachment = undefined;
      attachment.active = false;
      throw new StateError("Demo Router history state subscription failed");
    }
    attachment.unsubscribe = unsubscribe as () => void;

    return () => {
      this.detach(attachment);
      return undefined;
    };
  }

  readInitialState(documentUrl: string): DocumentHistoryState {
    const state = this.readRouteState();
    const normalizedDocumentUrl = normalizedUrl(documentUrl);
    if (!normalizedDocumentUrl) {
      throw new StateError("Demo Router history requires a valid document URL");
    }
    const routeUrl = state.kind === "managed" ? state.entry.url : state.url;
    if (routeUrl !== normalizedDocumentUrl) {
      throw new StateError("Demo Router history does not match the active document");
    }
    return state;
  }

  readRouteState(): DocumentHistoryState {
    const route = this.focusedAttachment().route;
    const entry = managedEntry(route);
    return entry
      ? Object.freeze({ entry, kind: "managed" })
      : Object.freeze({ kind: "unmanaged", url: routeDocumentUrl(route) });
  }

  reconcile(): void {
    if (this.terminal) throw new StateError("Demo Router history failed closed");
    this.reconcileAttachment(true);
  }

  subscribe(listener: (entry: DocumentHistoryEntry) => void): DocumentHistoryTraversalUnsubscribe {
    if (typeof listener !== "function") {
      throw new StateError("Demo Router history traversal requires a listener");
    }
    this.traversalListeners.add(listener);
    this.reconcileAttachment(false);
    return () => {
      this.traversalListeners.delete(listener);
      return undefined;
    };
  }

  subscribeErrors(listener: DemoRouterErrorListener): () => undefined {
    if (typeof listener !== "function") {
      throw new StateError("Demo Router history errors require a listener");
    }
    this.errorListeners.add(listener);
    listener(this.error);
    return () => {
      this.errorListeners.delete(listener);
      return undefined;
    };
  }

  reportError(error: Error): void {
    this.error = error;
    for (const listener of [...this.errorListeners]) listener(error);
  }

  clearError(): void {
    if (!this.error) return;
    this.error = undefined;
    for (const listener of [...this.errorListeners]) listener(undefined);
  }

  write(method: DocumentHistoryWriteMethod, entry: DocumentHistoryEntry): undefined {
    const attachment = this.attachment;
    if (!attachment?.active) throw new StateError("Demo Router history is not attached");
    const before = this.focusedAttachment();
    const current = this.currentEntry();
    const managed = managedEntry(before.route);
    const initialRepair = current === undefined && method === "replace";
    if (!initialRepair && !entriesEqual(managed, current)) {
      throw new StateError("Demo Router history route is not aligned with the package ledger");
    }
    const params = mergedParams(before.route, entry);
    if (this.writeActive) throw new StateError("Demo Router history write is already active");
    this.writeActive = true;
    this.pendingEntry = entry;
    try {
      const result =
        method === "push"
          ? attachment.navigation.push(DEMO_ROUTER_ROUTE_NAME, params)
          : attachment.navigation.setParams(params);
      assertUndefinedResult(result, "Demo Router history write failed");
      const after = routeState(attachment.navigation);
      if (method === "push") this.assertPush(before, after, entry);
      else this.assertReplace(before, after, attachment, entry);
    } catch {
      try {
        this.rollback(attachment.navigation, before.state);
      } catch {
        this.terminal = true;
        this.detach(attachment);
        const error = new StateError("Demo Router history write failed closed");
        this.reportError(error);
        throw error;
      }
      throw new StateError("Demo Router history write failed");
    } finally {
      this.pendingEntry = undefined;
      this.writeActive = false;
    }
    return undefined;
  }

  back(): void {
    const { navigation } = this.focusedAttachment();
    if (!navigation.canGoBack()) throw new StateError("Demo Router history cannot go back");
    navigation.goBack();
  }

  openExternal(url: string): Promise<void> | void {
    return this.openExternalUrl(url);
  }

  visit(_url: string, action: VisitAction): void {
    if (action === "restore") {
      this.back();
      return;
    }
    throw new StateError("Demo Router delegated document visits are unsupported");
  }

  dispose(): void {
    this.detach(this.attachment);
    this.traversalListeners.clear();
    this.errorListeners.clear();
    this.error = undefined;
    this.emittedEntry = undefined;
    this.pendingEntry = undefined;
  }

  private focusedAttachment(): Readonly<{
    navigation: DemoRouterNavigation;
    route: DemoRouterRoute;
    state: DemoRouterState;
  }> {
    const attachment = this.attachment;
    if (!attachment?.active) throw new StateError("Demo Router history is not attached");
    const focused = routeState(attachment.navigation);
    if (focused.route.key !== attachment.routeKey) {
      throw new StateError("Demo Router history attachment is not focused");
    }
    return Object.freeze({ navigation: attachment.navigation, ...focused });
  }

  private assertPush(
    before: Readonly<{ route: DemoRouterRoute; state: DemoRouterState }>,
    after: Readonly<{ route: DemoRouterRoute; state: DemoRouterState }>,
    entry: DocumentHistoryEntry,
  ): void {
    const expected = expectedPushState(
      before.state,
      after.route,
      DEMO_ROUTER_ROUTE_NAME,
      mergedParams(before.route, entry),
    );
    if (
      before.state.index !== before.state.routes.length - 1 ||
      after.route.key === before.route.key ||
      !sameStackState(expected, after.state)
    ) {
      throw new StateError("Demo Router history push did not commit exactly");
    }
  }

  private assertReplace(
    before: Readonly<{ route: DemoRouterRoute; state: DemoRouterState }>,
    after: Readonly<{ route: DemoRouterRoute; state: DemoRouterState }>,
    attachment: DemoRouterAttachment,
    entry: DocumentHistoryEntry,
  ): void {
    const expected = expectedReplaceState(before.state, mergedParams(before.route, entry));
    if (
      after.route.key !== attachment.routeKey ||
      !sameStackState(expected, after.state)
    ) {
      throw new StateError("Demo Router history replacement did not commit exactly");
    }
  }

  private handleState(attachment: DemoRouterAttachment): void {
    if (this.attachment !== attachment || !attachment.active || this.writeActive) return;
    try {
      this.reconcileAttachment(true);
    } catch (error) {
      this.reportError(
        error instanceof Error ? error : new StateError("Demo Router history traversal failed"),
      );
    }
  }

  private rollback(navigation: DemoRouterNavigation, state: DemoRouterState): void {
    let result: unknown;
    try {
      result = navigation.reset(state);
    } catch {
      throw new StateError("Demo Router history rollback failed");
    }
    assertUndefinedResult(result, "Demo Router history rollback failed");
    const restored = routeState(navigation).state;
    if (!sameStackState(state, restored)) {
      throw new StateError("Demo Router history rollback failed");
    }
  }

  private reconcileAttachment(throwOnMalformed: boolean): void {
    const attachment = this.attachment;
    const current = this.currentEntry();
    if (!attachment?.active || !current) return;
    let focused: Readonly<{ route: DemoRouterRoute; state: DemoRouterState }>;
    try {
      focused = routeState(attachment.navigation);
    } catch (error) {
      if (throwOnMalformed) throw error;
      this.reportError(
        error instanceof Error ? error : new StateError("Demo Router history traversal failed"),
      );
      return;
    }
    let entry: DocumentHistoryEntry | undefined;
    try {
      entry = managedEntry(focused.route);
    } catch (error) {
      if (this.malformedRouteKey !== focused.route.key) {
        this.malformedRouteKey = focused.route.key;
        const safeError =
          error instanceof Error
            ? error
            : new StateError("Demo Router history traversal metadata is invalid");
        if (throwOnMalformed) throw safeError;
        this.reportError(safeError);
      }
      return;
    }
    if (!entry) {
      if (this.malformedRouteKey !== focused.route.key) {
        this.malformedRouteKey = focused.route.key;
        const error = new StateError("Demo Router history traversal metadata is invalid");
        if (throwOnMalformed) throw error;
        this.reportError(error);
      }
      return;
    }
    this.malformedRouteKey = undefined;
    if (entriesEqual(entry, this.pendingEntry) || entriesEqual(entry, current)) {
      this.emittedEntry = undefined;
      this.clearError();
      return;
    }
    if (entriesEqual(entry, this.emittedEntry) || this.traversalListeners.size === 0) return;
    this.emittedEntry = entry;
    for (const listener of [...this.traversalListeners]) listener(entry);
  }

  private detach(attachment: DemoRouterAttachment | undefined): void {
    if (!attachment?.active) return;
    attachment.active = false;
    if (this.attachment === attachment) this.attachment = undefined;
    const unsubscribe = attachment.unsubscribe;
    attachment.unsubscribe = undefined;
    if (!unsubscribe) return;
    let result: unknown;
    try {
      result = unsubscribe();
    } catch {
      this.reportError(new StateError("Demo Router history state unsubscribe failed"));
      return;
    }
    if (result !== undefined) {
      if ((typeof result === "object" && result !== null) || typeof result === "function") {
        try {
          void Promise.resolve(result).catch(() => undefined);
        } catch {
          // The safe bridge error below is the only exposed cleanup failure.
        }
      }
      this.reportError(new StateError("Demo Router history state unsubscribe failed"));
    }
  }
}
