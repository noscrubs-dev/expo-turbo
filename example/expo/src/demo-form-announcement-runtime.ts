import { AccessibilityInfo, Platform } from "react-native";

import { createDemoFormAnnouncementAdapter } from "./demo-form-announcements";

export const DEMO_FORM_ANNOUNCEMENTS = createDemoFormAnnouncementAdapter(
  Platform.OS,
  AccessibilityInfo,
);
