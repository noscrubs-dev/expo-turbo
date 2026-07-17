import { defineStyleAdapter } from "expo-turbo/adapters";
import type { ViewStyle } from "react-native";

export const DEMO_STYLE_TOKENS = [
  "layout:row",
  "layout:stack",
  "safe-area:top",
  "space:comfortable",
  "space:compact",
  "surface:elevated",
  "tone:info",
  "tone:warning",
] as const;

export type DemoStyle = Readonly<ViewStyle>;
export type DemoStylePlatform = "android" | "ios" | "web";
export type DemoStyleToken = (typeof DEMO_STYLE_TOKENS)[number];

export interface DemoStyleAdapterOptions {
  readonly platform: DemoStylePlatform;
  readonly safeAreaTop: number;
}

function style(value: ViewStyle): DemoStyle {
  return Object.freeze(value);
}

function elevatedStyle(platform: DemoStylePlatform): DemoStyle {
  if (platform === "android") return style({ elevation: 4 });
  if (platform === "ios") {
    return style({
      shadowColor: "#132238",
      shadowOffset: { height: 2, width: 0 },
      shadowOpacity: 0.18,
      shadowRadius: 5,
    });
  }
  return style({ boxShadow: "0 2px 8px rgba(19, 34, 56, 0.18)" });
}

export function createDemoStyleAdapter(options: DemoStyleAdapterOptions) {
  if (!Number.isFinite(options.safeAreaTop) || options.safeAreaTop < 0) {
    throw new Error("Demo safe-area inset must be a finite nonnegative number");
  }
  if (!["android", "ios", "web"].includes(options.platform)) {
    throw new Error("Demo style platform is unsupported");
  }

  return defineStyleAdapter<DemoStyleToken, DemoStyle>({
    compose: (styles) => Object.freeze(Object.assign({}, ...styles)),
    maxTokens: 5,
    tokens: {
      "layout:row": {
        components: ["DemoCard"],
        group: "layout",
        style: style({ flexDirection: "row" }),
      },
      "layout:stack": {
        components: ["DemoCard"],
        group: "layout",
        style: style({ flexDirection: "column" }),
      },
      "safe-area:top": {
        components: ["DemoCard"],
        group: "safe-area",
        style: style({ paddingTop: options.safeAreaTop }),
      },
      "space:comfortable": {
        components: ["DemoCard"],
        group: "space",
        style: style({ gap: 8, padding: 16 }),
      },
      "space:compact": {
        components: ["DemoCard"],
        group: "space",
        style: style({ gap: 4, padding: 8 }),
      },
      "surface:elevated": {
        components: ["DemoCard"],
        group: "surface",
        style: elevatedStyle(options.platform),
      },
      "tone:info": {
        components: ["DemoCard"],
        group: "tone",
        style: style({ backgroundColor: "#eef6ff", borderColor: "#9fc4ef" }),
      },
      "tone:warning": {
        components: ["DemoCard"],
        group: "tone",
        style: style({ backgroundColor: "#fff8e7", borderColor: "#f1cf78" }),
      },
    },
  });
}

export const DEMO_CARD_BASE_STYLE = style({
  backgroundColor: "white",
  borderColor: "#d8dee7",
  borderRadius: 16,
  borderWidth: 1,
  gap: 6,
  padding: 12,
});

export const DEMO_CARD_TONE_STYLES = Object.freeze({
  positive: style({ backgroundColor: "#effaf3", borderColor: "#85c99c" }),
  warning: style({ backgroundColor: "#fff8e7", borderColor: "#f1cf78" }),
});
