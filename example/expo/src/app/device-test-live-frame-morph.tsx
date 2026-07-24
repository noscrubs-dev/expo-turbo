import { Stack } from "expo-router/stack";
import { ScrollView } from "react-native";

import { DemoLiveMorphProof } from "../demo-live-morph";

const origin = process.env.EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN;

export default function DeviceTestLiveFrameMorphRoute() {
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} testID="device-test-live-frame-morph">
      <Stack.Screen options={{ title: "Live Frame morph device test" }} />
      {origin ? <DemoLiveMorphProof origin={origin} /> : null}
    </ScrollView>
  );
}
