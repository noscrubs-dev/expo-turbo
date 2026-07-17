import {
  createRegistry,
  defineComponent,
  defineComponentModule,
  stringCodec,
} from "expo-turbo/registry";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { z } from "zod";

const gallery = defineComponent({
  attributes: {},
  children: "nodes",
  component: ({ children }: { children?: ReactNode }) => (
    <View style={{ gap: 12 }}>{children}</View>
  ),
  schema: z.object({}),
  tag: "Gallery",
});

const card = defineComponent({
  attributes: { title: { codec: stringCodec, prop: "title" } },
  children: "nodes",
  component: ({ children, title }) => (
    <View
      style={{
        backgroundColor: "#fff8e7",
        borderColor: "#f1cf78",
        borderRadius: 16,
        borderWidth: 1,
        gap: 6,
        padding: 16,
      }}
    >
      <Text selectable style={{ fontSize: 17, fontWeight: "600" }}>
        {title}
      </Text>
      {children}
    </View>
  ),
  schema: z.object({ title: z.string() }),
  tag: "DemoCard",
});

const text = defineComponent({
  attributes: {},
  children: "text",
  component: ({ children }: { children?: ReactNode }) => (
    <Text selectable style={{ color: "#435160", fontSize: 14, lineHeight: 21 }}>
      {children}
    </Text>
  ),
  schema: z.object({}),
  tag: "DemoText",
});

export const DEMO_REGISTRY = createRegistry(
  defineComponentModule({
    components: [gallery, card, text],
    name: "demo-primitives",
    version: "0.1.0",
  }),
);

export const DEMO_DOCUMENT = `<Gallery>
  <DemoCard id="static-renderer" title="Rendered from XML">
    <DemoText>This native card was admitted by Zod and rendered through expo-turbo/react.</DemoText>
  </DemoCard>
  <turbo-frame id="preview-frame">
    <DemoCard title="Frame boundary">
      <DemoText>The static renderer keeps the Frame in the protocol tree and renders its current children.</DemoText>
    </DemoCard>
  </turbo-frame>
</Gallery>`;
