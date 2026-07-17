import { createComponentStyleHook } from "expo-turbo/react";
import { Platform } from "react-native";

import {
  createDemoStyleAdapter,
  type DemoStylePlatform,
} from "./demo-styles";

const platform: DemoStylePlatform =
  Platform.OS === "android" || Platform.OS === "ios" ? Platform.OS : "web";

export const DEMO_STYLE_ADAPTER = createDemoStyleAdapter({
  platform,
  safeAreaTop: 0,
});

export const useDemoComponentStyle = createComponentStyleHook(DEMO_STYLE_ADAPTER);
