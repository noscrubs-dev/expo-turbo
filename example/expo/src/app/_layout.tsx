import { Stack } from "expo-router/stack"

import { DemoRuntimeProvider } from "../demo-runtime"

export default function RootLayout() {
  return (
    <DemoRuntimeProvider>
      <Stack />
    </DemoRuntimeProvider>
  )
}
