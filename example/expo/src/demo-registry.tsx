import {
  createRegistry,
  defineComponent,
  defineComponentModule,
  stringCodec,
} from "expo-turbo/registry";
import type { ReactNode } from "react";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";

import { useComponentAction } from "expo-turbo/react";
import { recordGreeting } from "./demo-actions";

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

function DemoActionComponent({ message }: { message: string }) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("Ready");
  const execute = useComponentAction(recordGreeting, {
    onEnd: () => setPending(false),
    onError: ({ error }) => setStatus(error.message),
    onSuccess: ({ result }) => setStatus(result),
  });
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        disabled={pending}
        onPress={() => {
          setPending(true);
          void execute({ message }).catch(() => undefined);
        }}
        style={({ pressed }) => ({
          alignItems: "center",
          backgroundColor: pressed ? "#19375a" : "#285589",
          borderRadius: 12,
          opacity: pending ? 0.6 : 1,
          padding: 12,
        })}
      >
        <Text style={{ color: "white", fontWeight: "600" }}>
          {pending ? "Running…" : "Run typed component action"}
        </Text>
      </Pressable>
      <Text selectable style={{ color: "#435160", fontSize: 13 }}>
        {status}
      </Text>
    </View>
  );
}

const action = defineComponent({
  attributes: { message: { codec: stringCodec, prop: "message" } },
  children: "none",
  component: DemoActionComponent,
  schema: z.object({ message: z.string() }),
  tag: "DemoAction",
});

export const DEMO_REGISTRY = createRegistry(
  defineComponentModule({
    components: [gallery, card, text, action],
    name: "demo-primitives",
    version: "0.1.0",
  }),
);

export const DEMO_DOCUMENT = `<Gallery>
  <DemoCard id="static-renderer" title="Rendered from XML">
    <DemoText>This native card was admitted by Zod and rendered through expo-turbo/react.</DemoText>
  </DemoCard>
  <DemoAction message="Hello from validated XML" />
  <turbo-frame id="preview-frame" src="/demo/frame" loading="lazy">
    <DemoCard title="Frame boundary">
      <DemoText>The static renderer keeps the Frame in the protocol tree and renders its current children.</DemoText>
    </DemoCard>
  </turbo-frame>
</Gallery>`;
