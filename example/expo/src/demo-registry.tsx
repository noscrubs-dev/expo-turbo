import {
  createRegistry,
  defineComponent,
  defineComponentModule,
  enumCodec,
  presenceCodec,
  stringCodec,
  tokenListCodec,
} from "expo-turbo/registry";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { z } from "zod";

import {
  useComponentAction,
  useDocumentState,
  useExpoTurboDocumentLink,
  ExpoTurboFormScope,
  useExpoTurboForm,
  useExpoTurboFormControl,
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
  disabled,
  href,
}: {
  children?: ReactNode;
  disabled: boolean;
  href: string;
}) {
  const activate = useExpoTurboDocumentLink(href);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const unavailable = disabled || pending;
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="link"
        accessibilityState={{ busy: pending, disabled: unavailable }}
        disabled={unavailable}
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
          opacity: unavailable ? 0.6 : 1,
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
  attributes: {
    disabled: { codec: presenceCodec, prop: "disabled" },
    href: { codec: stringCodec, prop: "href" },
  },
  children: "nodes",
  component: DemoDocumentLinkComponent,
  schema: z.object({ disabled: z.boolean().default(false), href: z.string().trim().min(1) }),
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

function DemoFormComponent({ children }: { children?: ReactNode }) {
  return (
    <ExpoTurboFormScope>
      <DemoFormSurface>{children}</DemoFormSurface>
    </ExpoTurboFormScope>
  );
}

function DemoFormSurface({ children }: { children?: ReactNode }) {
  const form = useExpoTurboForm();
  return (
    <View
      accessibilityLabel={form.state.busy ? "Form submitting" : "Form ready"}
      accessibilityState={form.accessibilityState}
      accessible
      style={{
        backgroundColor: "#f6f8fa",
        borderColor: "#c8d1dc",
        borderRadius: 12,
        borderWidth: 1,
        gap: 10,
        padding: 12,
      }}
    >
      {children}
    </View>
  );
}

const form = defineComponent({
  attributes: {
    action: { codec: stringCodec, prop: "action" },
    method: { codec: stringCodec, prop: "method" },
  },
  children: "nodes",
  component: DemoFormComponent,
  schema: z.object({ action: z.string().optional(), method: z.string().optional() }),
  tag: "DemoForm",
});

function DemoFormInputComponent({
  label,
  name,
  value,
}: {
  label: string;
  name: string;
  value: string;
}) {
  const [current, setCurrent] = useState(value);
  useExpoTurboFormControl({ kind: "value", name, value: current });
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: "#435160", fontSize: 13 }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        onChangeText={setCurrent}
        style={{
          backgroundColor: "white",
          borderColor: "#9eb0c3",
          borderRadius: 10,
          borderWidth: 1,
          color: "#172230",
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
        value={current}
      />
    </View>
  );
}

const formInput = defineComponent({
  attributes: {
    label: { codec: stringCodec, prop: "label" },
    name: { codec: stringCodec, prop: "name" },
    value: { codec: stringCodec, prop: "value" },
  },
  children: "none",
  component: DemoFormInputComponent,
  schema: z.object({ label: z.string(), name: z.string(), value: z.string() }),
  tag: "DemoFormInput",
});

function DemoFormSubmitterComponent(props: {
  formaction?: string;
  formmethod?: string;
  label: string;
  name: string;
  value: string;
}) {
  const { label, name, value } = props;
  const formBinding = useExpoTurboForm();
  const control = useExpoTurboFormControl({ kind: "submitter", name, value });
  const requestId = useRef(0);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={control.accessibilityState}
      disabled={control.disabled}
      onPress={() => {
        void formBinding
          .submit({
            protocol: { requestId: `demo-form-${++requestId.current}` },
            submitter: control.selection(),
          })
          .catch(() => undefined);
      }}
      style={({ pressed }) => ({
        alignItems: "center",
        backgroundColor: pressed ? "#19375a" : "#285589",
        borderRadius: 10,
        padding: 12,
      })}
    >
      <Text style={{ color: "white", fontWeight: "600" }}>
        {control.submitsWith ?? label}
      </Text>
    </Pressable>
  );
}

const formSubmitter = defineComponent({
  attributes: {
    formaction: { codec: stringCodec, prop: "formaction" },
    formmethod: { codec: stringCodec, prop: "formmethod" },
    label: { codec: stringCodec, prop: "label" },
    name: { codec: stringCodec, prop: "name" },
    value: { codec: stringCodec, prop: "value" },
  },
  children: "none",
  component: DemoFormSubmitterComponent,
  schema: z.object({
    formaction: z.string().optional(),
    formmethod: z.string().optional(),
    label: z.string(),
    name: z.string(),
    value: z.string(),
  }),
  tag: "DemoFormSubmitter",
});

export const DEMO_REGISTRY = createRegistry(
  defineComponentModule({
    components: [
      gallery,
      card,
      text,
      action,
      documentLink,
      form,
      formInput,
      formSubmitter,
    ],
    name: "demo-primitives",
    version: "0.1.0",
  }),
);

export const DEMO_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="static-renderer" title="Rendered from XML" style-tokens="tone:info space:comfortable surface:elevated">
    <DemoText>This native card was admitted by Zod and rendered through expo-turbo/react.</DemoText>
  </DemoCard>
  <DemoAction message="Hello from validated XML" />
  <DemoCard id="native-form-card" title="Live native form controls" style-tokens="tone:info space:compact">
    <DemoText>Edit either native value, approve the host-owned native confirmation, then submit once through the exact-form activity guard. The fixture fails its first safe GET so the registered form boundary can retry from current values with a fresh request ID.</DemoText>
    <DemoForm id="native-form" action="/demo/profile" method="post">
      <DemoFormInput id="first-name" label="First name" name="profile[first_name]" value="Ada" />
      <DemoFormInput id="city" label="City" name="profile[city]" value="London" />
      <DemoFormSubmitter id="collect-form" data-turbo-confirm="Send this immutable preview?" data-turbo-submits-with="Submitting preview…" formaction="/demo/profile/preview" formmethod="get" label="Confirm and submit immutable request" name="commit" value="preview" />
    </DemoForm>
  </DemoCard>
  <DemoDocumentLink href="/demo/linked">
    <DemoText>Open a same-origin document through the app-owned native link.</DemoText>
  </DemoDocumentLink>
  <DemoDocumentLink href="https://example.com">
    <DemoText>Delegate a safe cross-origin link through the app-owned navigation adapter.</DemoText>
  </DemoDocumentLink>
  <DemoDocumentLink disabled="" href="/demo/disabled">
    <DemoText>Disabled native links remain visible without activating a request or navigation.</DemoText>
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
