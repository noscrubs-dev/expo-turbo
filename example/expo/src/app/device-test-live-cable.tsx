import { Stack } from "expo-router/stack";
import { ScrollView } from "react-native";

import { DemoLiveCableProof } from "../demo-live-cable";

const origin = process.env.EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN;

export default function DeviceTestLiveCableRoute() {
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} testID="device-test-live-cable">
      <Stack.Screen options={{ title: "Live Cable device test" }} />
      {origin ? <DemoLiveCableProof origin={origin} /> : null}
    </ScrollView>
  );
}
