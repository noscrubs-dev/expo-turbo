import { Stack } from "expo-router"
import { EXPO_TURBO_STATUS } from "expo-turbo"
import { ScrollView, Text, View } from "react-native"

export default function HomeScreen() {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ gap: 16, padding: 24 }}
    >
      <Stack.Screen options={{ title: "Expo Turbo" }} />
      <View style={{ gap: 8 }}>
        <Text selectable style={{ fontSize: 28, fontWeight: "700" }}>
          Compatibility gallery
        </Text>
        <Text selectable style={{ color: "#59636e", fontSize: 16, lineHeight: 24 }}>
          The standalone device harness is ready for protocol scenarios.
        </Text>
      </View>
      <View
        style={{
          backgroundColor: "#eef6ff",
          borderCurve: "continuous",
          borderRadius: 16,
          gap: 6,
          padding: 16,
        }}
      >
        <Text selectable style={{ color: "#435160", fontSize: 13 }}>
          Package status
        </Text>
        <Text selectable style={{ fontSize: 17, fontWeight: "600" }}>
          {EXPO_TURBO_STATUS}
        </Text>
      </View>
    </ScrollView>
  )
}
