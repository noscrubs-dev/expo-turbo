import { Stack } from "expo-router/stack";
import { ScrollView } from "react-native";

import { DemoLiveFormProof } from "../demo-live-form";

const origin = process.env.EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN;

export default function LiveFrameFormRoute() {
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} testID="demo-live-form-test-entry">
      <Stack.Screen options={{ title: "Live Rails Frame form" }} />
      {origin ? <DemoLiveFormProof origin={origin} showExplanation={false} /> : null}
    </ScrollView>
  );
}
