import {
  createRegistry,
  defineComponent,
  defineComponentModule,
  enumCodec,
  stringCodec,
  tokenListCodec,
} from "expo-turbo/registry";
import type { ReactNode } from "react";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";

import {
  useComponentAction,
  useDocumentState,
  useExpoTurboDocumentLink,
} from "expo-turbo/react";
import { recordGreeting } from "./demo-actions";
import { useDemoComponentStyle } from "./demo-style-runtime";
import {
  DEMO_CARD_BASE_STYLE,
  DEMO_CARD_TONE_STYLES,
  DEMO_STYLE_TOKENS,
  type DemoStyleToken,
} from "./demo-styles";

const gallery = defineComponent({
  attributes: {},
  children: "nodes",
  component: ({ children }: { children?: ReactNode }) => (
    <View style={{ gap: 12 }}>{children}</View>
  ),
  schema: z.object({}),
  tag: "Gallery",
});

function DemoCardComponent({
  children,
  styleTokens,
  title,
  tone,
}: {
  children?: ReactNode;
  styleTokens: readonly DemoStyleToken[];
  title: string;
  tone?: keyof typeof DEMO_CARD_TONE_STYLES;
}) {
  const resolvedStyle = useDemoComponentStyle({
    component: DEMO_CARD_BASE_STYLE,
    ...(tone ? { props: DEMO_CARD_TONE_STYLES[tone] } : {}),
    tokens: styleTokens,
  });
  return (
    <View
      style={resolvedStyle}
    >
      <Text selectable style={{ fontSize: 17, fontWeight: "600" }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

const card = defineComponent({
  attributes: {
    "style-tokens": {
      codec: tokenListCodec("demo-style", DEMO_STYLE_TOKENS, {
        maxTokens: 5,
      }),
      prop: "styleTokens",
    },
    title: { codec: stringCodec, prop: "title" },
    tone: {
      codec: enumCodec(["positive", "warning"]),
      prop: "tone",
    },
  },
  children: "nodes",
  component: DemoCardComponent,
  schema: z.object({
    styleTokens: z.array(z.enum(DEMO_STYLE_TOKENS)).readonly().default([]),
    title: z.string(),
    tone: z.enum(["positive", "warning"]).optional(),
  }),
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

function DemoDocumentLinkComponent({
  children,
  href,
}: {
  children?: ReactNode;
  href: string;
}) {
  const activate = useExpoTurboDocumentLink(href);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="link"
        accessibilityState={{ busy: pending, disabled: pending }}
        disabled={pending}
        onPress={() => {
          setError(undefined);
          setPending(true);
          void activate()
            .catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : "Document visit failed");
            })
            .finally(() => setPending(false));
        }}
        style={({ pressed }) => ({
          alignItems: "center",
          backgroundColor: pressed ? "#d5e6f7" : "#e7f1fb",
          borderColor: "#9ebcda",
          borderRadius: 12,
          borderWidth: 1,
          opacity: pending ? 0.6 : 1,
          padding: 12,
        })}
      >
        {children}
      </Pressable>
      {error ? (
        <Text selectable style={{ color: "#a62525", fontSize: 13 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const documentLink = defineComponent({
  attributes: { href: { codec: stringCodec, prop: "href" } },
  children: "nodes",
  component: DemoDocumentLinkComponent,
  schema: z.object({ href: z.string().trim().min(1) }),
  tag: "DemoDocumentLink",
});

function DemoActionComponent({ message }: { message: string }) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("Ready");
  const greeting = useDocumentState<string>("last-greeting");
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
      <Text selectable style={{ color: "#435160", fontSize: 13 }}>
        Document state: {greeting.value ?? "not set"}
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
    components: [gallery, card, text, action, documentLink],
    name: "demo-primitives",
    version: "0.1.0",
  }),
);

export const DEMO_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="static-renderer" title="Rendered from XML" style-tokens="tone:info space:comfortable surface:elevated">
    <DemoText>This native card was admitted by Zod and rendered through expo-turbo/react.</DemoText>
  </DemoCard>
  <DemoAction message="Hello from validated XML" />
  <DemoDocumentLink href="/demo/linked">
    <DemoText>Open a same-origin document through the app-owned native link.</DemoText>
  </DemoDocumentLink>
  <DemoDocumentLink href="https://example.com">
    <DemoText>Delegate a safe cross-origin link through the app-owned navigation adapter.</DemoText>
  </DemoDocumentLink>
  <turbo-frame id="link-frame">
    <DemoCard title="Frame-scoped native link" style-tokens="tone:info space:compact">
      <DemoDocumentLink href="/demo/frame-linked">
        <DemoText>Load this Frame through the shared Frame visit controller.</DemoText>
      </DemoDocumentLink>
    </DemoCard>
  </turbo-frame>
  <turbo-frame id="preview-frame" src="/demo/frame" loading="lazy">
    <DemoCard title="Frame boundary" style-tokens="tone:warning space:compact">
      <DemoText>The static renderer keeps the Frame in the protocol tree and renders its current children.</DemoText>
    </DemoCard>
  </turbo-frame>
</Gallery>`;
