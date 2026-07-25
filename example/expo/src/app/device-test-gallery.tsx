import { parseExpoTurboDocument } from "expo-turbo/core";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { Text } from "react-native";

import { activateDemoDeviceTestScenario } from "../demo-device-test-control";
import { demoDeviceTestScenario } from "../demo-device-test-scenarios";
import { useDemoRuntime } from "../demo-runtime";

export default function DeviceTestGalleryRoute() {
  const { scenario } = useLocalSearchParams<{ scenario?: string | string[] }>();
  const runtime = useDemoRuntime();
  const document = demoDeviceTestScenario(scenario);

  useEffect(() => {
    if (!document) return;
    runtime.session.replaceTree(
      parseExpoTurboDocument(
        document.replace("<Gallery ", '<Gallery id="device-test-gallery" '),
        { url: "https://example.test/demo" },
      ),
    );
    const entry = runtime.documentRuntime.history.current;
    if (entry) {
      runtime.documentRuntime.history.updateRestorationData(entry.restorationIdentifier, {
        scrollPosition: { x: 0, y: 0 },
      });
    }
    runtime.documentRefreshScroll.reset();
    activateDemoDeviceTestScenario();
    requestAnimationFrame(() => router.back());
  }, [
    document,
    runtime.documentRefreshScroll,
    runtime.documentRuntime.history,
    runtime.session,
  ]);

  return <Text>{document ? "Preparing device scenario" : "Unknown device scenario"}</Text>;
}
