import { useSyncExternalStore } from "react";

type DemoDeviceTestListener = () => void;

const listeners = new Set<DemoDeviceTestListener>();
let active = false;

export function activateDemoDeviceTestScenario(): void {
  active = true;
  for (const listener of listeners) listener();
}

export function isDemoDeviceTestScenarioActive(): boolean {
  return active;
}

export function subscribeDemoDeviceTestScenario(listener: DemoDeviceTestListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDemoDeviceTestScenario(): boolean {
  return useSyncExternalStore(
    subscribeDemoDeviceTestScenario,
    isDemoDeviceTestScenarioActive,
    isDemoDeviceTestScenarioActive,
  );
}
