import { ExpoTurboApp } from "expo-turbo/expo";

import { DEMO_REGISTRY } from "../demo-registry";

const ORIGIN = process.env.EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN ?? "http://127.0.0.1:3001";

// The whole zero-configuration adoption surface. Drop `path` and the document
// follows the mounted Expo Router pathname, which is what makes a catch-all
// route need no configuration at all.
export default function TurboAppRoute() {
  return (
    <ExpoTurboApp
      origin={ORIGIN}
      path="/api/expo_turbo/demo/document"
      registry={DEMO_REGISTRY}
    />
  );
}
