import { Stack } from "expo-router/stack";
import { ScrollView } from "react-native";

import { DemoLiveDocumentRefreshMorphProof } from "../demo-live-document-refresh-morph";

const origin = process.env.EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN;

export default function DeviceTestDocumentRefreshMorphRoute() {
  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      testID="device-test-document-refresh-morph"
    >
      <Stack.Screen options={{ title: "Document Refresh morph device test" }} />
      {origin ? <DemoLiveDocumentRefreshMorphProof origin={origin} /> : null}
    </ScrollView>
  );
}
