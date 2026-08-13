import { ExpoTurboApp } from "expo-turbo/expo";

import { DEMO_REGISTRY } from "../../../../demo-registry";

const ORIGIN = process.env.EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN ?? "http://127.0.0.1:3001";

export default function TurboAppRoute() {
  return <ExpoTurboApp origin={ORIGIN} registry={DEMO_REGISTRY} />;
}
