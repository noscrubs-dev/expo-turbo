import { Stack } from "expo-router/stack";
import { useRef } from "react";
import { ScrollView } from "react-native";

import { DemoLiveFormProof } from "../demo-live-form";

const origin = process.env.EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN;

export default function DeviceTestLiveFormSecondaryRoute() {
  const scrollView = useRef<ScrollView>(null);

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      onContentSizeChange={() => {
        requestAnimationFrame(() => scrollView.current?.scrollToEnd({ animated: false }));
      }}
      ref={scrollView}
      testID="device-test-live-form-secondary"
    >
      <Stack.Screen options={{ title: "Live form controls device test" }} />
      {origin ? <DemoLiveFormProof origin={origin} showExplanation={false} /> : null}
    </ScrollView>
  );
}
