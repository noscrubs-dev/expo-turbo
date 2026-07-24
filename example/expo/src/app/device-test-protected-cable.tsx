import { Stack } from "expo-router/stack";
import { ScrollView } from "react-native";

import { DemoLiveProtectedCableProof } from "../demo-live-cable";

const origin = process.env.EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN;

export default function DeviceTestProtectedCableRoute() {
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} testID="device-test-protected-cable">
      <Stack.Screen options={{ title: "Protected Cable device test" }} />
      {origin ? <DemoLiveProtectedCableProof origin={origin} /> : null}
    </ScrollView>
  );
}
