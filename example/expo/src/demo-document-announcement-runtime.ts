import { AccessibilityInfo, Platform } from "react-native";

import { createDemoDocumentAnnouncementAdapter } from "./demo-document-announcements";

export const DEMO_DOCUMENT_ANNOUNCEMENTS = createDemoDocumentAnnouncementAdapter(
  Platform.OS,
  AccessibilityInfo,
);
