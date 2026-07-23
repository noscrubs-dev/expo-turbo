import type { FetchAdapter } from "expo-turbo/adapters"
import {
  DocumentSession,
  ExpoTurboError,
  FrameLifecycle,
  FrameControllerRegistry,
  FrameRequestLoader,
  parseExpoTurboDocument,
  StateError,
} from "expo-turbo/core"
import { ExpoTurboProvider, ExpoTurboRoot } from "expo-turbo/react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { Pressable, Text, View } from "react-native"
import {
  createDemoLiveFetchAdapter,
  type DemoLiveFetch,
  nativeDemoLiveFetch,
} from "./demo-live-transport"
import { DEMO_REGISTRY } from "./demo-registry"
import { DEMO_STYLE_ADAPTER } from "./demo-style-runtime"

const OUTER_FRAME_ID = "morph-outer"
const INNER_FRAME_ID = "morph-inner"
const OUTER_PATH = "/api/expo_turbo/demo/morph/outer"
const INNER_PATH = "/api/expo_turbo/demo/morph/inner"
const liveRuntimeOwners = new WeakMap<DemoLiveMorphRuntime, number>()

export interface DemoLiveMorphRuntimeOptions {
  readonly fetch?: DemoLiveFetch
  readonly origin: string
}

export interface DemoLiveMorphEndpoints {
  readonly innerUrl: string
  readonly outerUrl: string
}

export interface DemoLiveMorphRuntime {
  dispose(): void
  readonly endpoints: DemoLiveMorphEndpoints
  readonly frames: FrameControllerRegistry
  reloadOuter(): Promise<void>
  readonly session: DocumentSession
  visitOuterWithMorph(): Promise<void>
}

type DemoLiveMorphInitialization = Readonly<{
  readonly error?: Error
  readonly proof?: DemoLiveMorphRuntime
}>

function asDisplayError(error: unknown): Error {
  return error instanceof ExpoTurboError
    ? error
    : new StateError("The standalone Rails morph demo is unavailable")
}

function loadingDocument(endpoints: DemoLiveMorphEndpoints): string {
  return `<Gallery id="demo-live-morph"><turbo-frame id="${OUTER_FRAME_ID}" loading="lazy" refresh="morph" src="${endpoints.outerUrl}"><Gallery id="morph-shell"><DemoText id="morph-outer-loading">Reload the outer Frame to begin the morph cascade</DemoText><turbo-frame id="${INNER_FRAME_ID}" loading="lazy" refresh="morph" src="${endpoints.innerUrl}"><DemoText id="morph-inner-loading">Waiting for the nested Frame reload</DemoText></turbo-frame></Gallery></turbo-frame></Gallery>`
}

export function resolveDemoLiveMorphEndpoints(origin: string): DemoLiveMorphEndpoints {
  const base = new URL(origin).origin
  return Object.freeze({
    innerUrl: new URL(INNER_PATH, base).toString(),
    outerUrl: new URL(OUTER_PATH, base).toString(),
  })
}

export function createDemoLiveMorphRuntime(
  options: DemoLiveMorphRuntimeOptions,
): DemoLiveMorphRuntime {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new StateError("Standalone Rails morph demo options are invalid")
  }
  const fetch = options.fetch ?? nativeDemoLiveFetch
  if (typeof fetch !== "function") {
    throw new StateError("Standalone Rails morph demo fetch is invalid")
  }
  const endpoints = resolveDemoLiveMorphEndpoints(options.origin)
  const session = new DocumentSession(
    parseExpoTurboDocument(loadingDocument(endpoints), { url: endpoints.outerUrl }),
  )
  const transport: FetchAdapter = createDemoLiveFetchAdapter(fetch)
  let frameRequestId = 0
  let selectOuterVisitMorph = false
  const frameLifecycle = new FrameLifecycle()
  frameLifecycle.subscribe("before-frame-render", (event) => {
    if (event.detail.frameId === OUTER_FRAME_ID && selectOuterVisitMorph) {
      event.detail.render = (context) => context.renderMorph()
    }
    return undefined
  })
  const frames = new FrameControllerRegistry(
    session,
    new FrameRequestLoader(
      session,
      transport,
      {
        next: () => `demo-live-morph-frame-${++frameRequestId}`,
      },
      { frameLifecycle },
    ),
  )
  let disposed = false

  return Object.freeze({
    dispose(): void {
      if (disposed) return
      disposed = true
      frames.dispose()
    },
    endpoints,
    frames,
    async reloadOuter(): Promise<void> {
      const outer = frames.get(OUTER_FRAME_ID)
      await outer.connect()
      await outer.reload()
    },
    session,
    async visitOuterWithMorph(): Promise<void> {
      const outer = frames.get(OUTER_FRAME_ID)
      await outer.connect()
      selectOuterVisitMorph = true
      try {
        await outer.visit(endpoints.outerUrl)
      } finally {
        selectOuterVisitMorph = false
      }
    },
  })
}

function useDemoLiveMorphRuntimeOwner(proof: DemoLiveMorphRuntime): void {
  useEffect(() => {
    liveRuntimeOwners.set(proof, (liveRuntimeOwners.get(proof) ?? 0) + 1)
    return () => {
      const owners = Math.max(0, (liveRuntimeOwners.get(proof) ?? 0) - 1)
      liveRuntimeOwners.set(proof, owners)
      queueMicrotask(() => {
        if (liveRuntimeOwners.get(proof) !== 0) return
        liveRuntimeOwners.delete(proof)
        proof.dispose()
      })
    }
  }, [proof])
}

export function DemoLiveMorphRuntimeProvider({
  children,
  proof,
}: Readonly<{ children?: ReactNode; proof: DemoLiveMorphRuntime }>) {
  useDemoLiveMorphRuntimeOwner(proof)
  return (
    <ExpoTurboProvider
      frames={proof.frames}
      registry={DEMO_REGISTRY}
      renderError={({ error }) => (
        <Text selectable style={{ color: "#a62525" }}>
          {error.name}: {error.message}
        </Text>
      )}
      session={proof.session}
      styles={DEMO_STYLE_ADAPTER}
    >
      {children}
    </ExpoTurboProvider>
  )
}

export function DemoLiveMorphPanel({ proof }: Readonly<{ proof: DemoLiveMorphRuntime }>) {
  const [error, setError] = useState<Error | undefined>()
  const [pendingAction, setPendingAction] = useState<"reload" | "visit" | undefined>()
  const reloadOuter = () => {
    if (pendingAction) return
    setPendingAction("reload")
    setError(undefined)
    void proof
      .reloadOuter()
      .catch((nextError) => setError(asDisplayError(nextError)))
      .finally(() => setPendingAction(undefined))
  }
  const visitOuterWithMorph = () => {
    if (pendingAction) return
    setPendingAction("visit")
    setError(undefined)
    void proof
      .visitOuterWithMorph()
      .catch((nextError) => setError(asDisplayError(nextError)))
      .finally(() => setPendingAction(undefined))
  }

  return (
    <View
      style={{
        borderColor: "#6d7f93",
        borderRadius: 12,
        borderWidth: 1,
        gap: 12,
        padding: 16,
      }}
    >
      <Text selectable style={{ fontSize: 18, fontWeight: "600" }}>
        Nested Frame refresh morph
      </Text>
      <Text selectable style={{ color: "#435160", lineHeight: 20 }}>
        This native-only proof reloads an outer Rails Frame with refresh morph. Its nested morph
        Frame keeps the mounted wrapper and ignores the outer response&apos;s stale inner payload,
        then reloads itself after the outer Frame has rendered and loaded. The second control sends
        an ordinary Frame visit and selects the same bounded renderer through before-frame-render.
      </Text>
      <DemoLiveMorphRuntimeProvider proof={proof}>
        <ExpoTurboRoot />
      </DemoLiveMorphRuntimeProvider>
      <Pressable
        accessibilityLabel="Reload outer morph Frame"
        accessibilityRole="button"
        disabled={pendingAction !== undefined}
        onPress={reloadOuter}
        style={({ pressed }) => ({
          alignItems: "center",
          backgroundColor: pressed || pendingAction ? "#33556f" : "#285589",
          borderRadius: 12,
          opacity: pendingAction ? 0.65 : 1,
          padding: 14,
        })}
      >
        <Text style={{ color: "white", fontSize: 15, fontWeight: "600" }}>
          {pendingAction === "reload" ? "Reloading outer Frame…" : "Reload outer morph Frame"}
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Visit outer Frame with morph renderer"
        accessibilityRole="button"
        disabled={pendingAction !== undefined}
        onPress={visitOuterWithMorph}
        style={({ pressed }) => ({
          alignItems: "center",
          backgroundColor: pressed || pendingAction ? "#4f5260" : "#626675",
          borderRadius: 12,
          opacity: pendingAction ? 0.65 : 1,
          padding: 14,
        })}
      >
        <Text style={{ color: "white", fontSize: 15, fontWeight: "600" }}>
          {pendingAction === "visit"
            ? "Visiting outer Frame…"
            : "Visit outer Frame with morph renderer"}
        </Text>
      </Pressable>
      {error ? (
        <Text selectable style={{ color: "#a62525" }}>
          {error.name}: {error.message}
        </Text>
      ) : null}
    </View>
  )
}

export function DemoLiveMorphProof({ origin }: Readonly<{ origin: string }>) {
  const result = useMemo<DemoLiveMorphInitialization>(() => {
    try {
      return Object.freeze({ proof: createDemoLiveMorphRuntime({ origin }) })
    } catch (nextError) {
      return Object.freeze({ error: asDisplayError(nextError) })
    }
  }, [origin])

  if (result.error) {
    return (
      <Text selectable style={{ color: "#a62525" }}>
        {result.error.name}: {result.error.message}
      </Text>
    )
  }
  if (!result.proof) throw new StateError("Standalone Rails morph demo initialization failed")
  return <DemoLiveMorphPanel proof={result.proof} />
}
