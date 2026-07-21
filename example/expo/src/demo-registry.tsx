import {
  createRegistry,
  defineComponent,
  defineComponentModule,
  enumCodec,
  jsonCodec,
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
  type ExpoTurboDirection,
  useExpoTurboDocumentLink,
  useExpoTurboDirection,
  useExpoTurboDocumentLinkPrefetch,
  ExpoTurboFormScope,
  useExpoTurboForm,
  useExpoTurboFormControl,
} from "expo-turbo/react";
import { recordGreeting } from "./demo-actions";
import { DemoFlatListRegion, DemoNestedScrollRegion } from "./demo-boundaries";
import { useDemoFocusHandle } from "./demo-focus";
import { useDemoComponentStyle } from "./demo-style-runtime";
import {
  DEMO_CARD_BASE_STYLE,
  DEMO_CARD_TONE_STYLES,
  DEMO_STYLE_TOKENS,
  type DemoStyleToken,
} from "./demo-styles";

function nativeLayoutDirection(direction: ExpoTurboDirection | undefined): "inherit" | "ltr" | "rtl" {
  return direction === "ltr" || direction === "rtl" ? direction : "inherit";
}

function DemoGalleryComponent({ children }: { children?: ReactNode }) {
  const direction = useExpoTurboDirection();
  return <View style={[{ gap: 12 }, { direction: nativeLayoutDirection(direction) }]}>{children}</View>;
}

const gallery = defineComponent({
  attributes: {},
  children: "nodes",
  component: DemoGalleryComponent,
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
  const direction = useExpoTurboDirection();
  const resolvedStyle = useDemoComponentStyle({
    component: DEMO_CARD_BASE_STYLE,
    ...(tone ? { props: DEMO_CARD_TONE_STYLES[tone] } : {}),
    tokens: styleTokens,
  });
  return (
    <View style={[resolvedStyle, { direction: nativeLayoutDirection(direction) }]}>
      <Text selectable style={{ fontSize: 17, fontWeight: "600", writingDirection: direction ?? "auto" }}>
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

function DemoTextComponent({ children }: { children?: ReactNode }) {
  const direction = useExpoTurboDirection();
  return (
    <Text selectable style={{ color: "#435160", fontSize: 14, lineHeight: 21, writingDirection: direction ?? "auto" }}>
      {children}
    </Text>
  );
}

const text = defineComponent({
  attributes: {},
  children: "text",
  component: DemoTextComponent,
  schema: z.object({}),
  tag: "DemoText",
});

const scrollRegion = defineComponent({
  attributes: { id: { codec: stringCodec, prop: "id" } },
  children: "nodes",
  component: DemoNestedScrollRegion,
  schema: z.object({ id: z.string().trim().min(1) }),
  tag: "DemoScrollRegion",
});

const flatListFrameIds = z.array(z.string().trim().min(1)).min(1).max(8).readonly();

const flatListRegion = defineComponent({
  attributes: {
    "frame-ids": {
      codec: jsonCodec("demo-flat-list-frame-ids", flatListFrameIds, { maxBytes: 512 }),
      prop: "frameIds",
    },
    id: { codec: stringCodec, prop: "id" },
  },
  children: "nodes",
  component: DemoFlatListRegion,
  schema: z.object({ frameIds: flatListFrameIds, id: z.string().trim().min(1) }),
  tag: "DemoFlatListRegion",
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
  const prefetch = useExpoTurboDocumentLinkPrefetch(href);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const unavailable = disabled || pending;
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="link"
        accessibilityState={{ busy: pending, disabled: unavailable }}
        disabled={unavailable}
        onPressIn={prefetch}
        onPressOut={prefetch.cancel}
        onPress={() => {
          prefetch.commit();
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
      accessible={false}
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

function DemoFormFieldsetComponent({
  children,
  disabled,
}: {
  children?: ReactNode;
  disabled: boolean;
}) {
  return (
    <View
      accessibilityState={{ disabled }}
      style={{
        borderColor: disabled ? "#c8d1dc" : "#9eb0c3",
        borderRadius: 10,
        borderWidth: 1,
        gap: 8,
        padding: 10,
      }}
    >
      {children}
    </View>
  );
}

const formFieldset = defineComponent({
  attributes: { disabled: { codec: presenceCodec, prop: "disabled" } },
  children: "nodes",
  component: DemoFormFieldsetComponent,
  formContainer: "fieldset",
  schema: z.object({ disabled: z.boolean().default(false) }),
  tag: "DemoFormFieldset",
});

const formLegend = defineComponent({
  attributes: {},
  children: "nodes",
  component: ({ children }: { children?: ReactNode }) => (
    <View style={{ gap: 8 }}>{children}</View>
  ),
  formContainer: "legend",
  schema: z.object({}),
  tag: "DemoFormLegend",
});

const form = defineComponent({
  attributes: {
    action: { codec: stringCodec, prop: "action" },
    method: { codec: stringCodec, prop: "method" },
  },
  children: "nodes",
  component: DemoFormComponent,
  formOwner: true,
  schema: z.object({ action: z.string().optional(), method: z.string().optional() }),
  tag: "DemoForm",
});

function DemoFormInputComponent({
  label,
  name,
  required,
  value,
}: {
  label: string;
  name: string;
  required: boolean;
  value: string;
}) {
  const direction = useExpoTurboDirection();
  const [current, setCurrent] = useState(value);
  const inputRef = useRef<TextInput>(null);
  const validation = required
    ? z.string().trim().min(1, `${label} is required`).safeParse(current)
    : undefined;
  const validity =
    validation === undefined || validation.success
      ? ({ valid: true } as const)
      : ({
          message: validation.error.issues[0]?.message ?? `${label} is invalid`,
          valid: false,
        } as const);
  const control = useExpoTurboFormControl({
    kind: "value",
    name,
    value: current,
    ...(required ? { validity } : {}),
  });
  const focusHandlers = useDemoFocusHandle(control.nodeKey, inputRef);
  return (
    <View style={{ direction: nativeLayoutDirection(direction), gap: 6, opacity: control.disabled ? 0.55 : 1 }}>
      <Text style={{ color: "#435160", fontSize: 13, writingDirection: direction ?? "auto" }}>{label}</Text>
      <TextInput
        accessibilityHint={!validity.valid ? validity.message : undefined}
        accessibilityLabel={label}
        accessibilityState={control.accessibilityState}
        editable={!control.disabled}
        onBlur={focusHandlers.onBlur}
        onChangeText={setCurrent}
        onFocus={focusHandlers.onFocus}
        ref={inputRef}
        style={{
          backgroundColor: "white",
          borderColor: validity.valid ? "#9eb0c3" : "#a62525",
          borderRadius: 10,
          borderWidth: 1,
          color: "#172230",
          paddingHorizontal: 12,
          paddingVertical: 10,
          writingDirection: direction ?? "auto",
        }}
        value={current}
      />
      {!validity.valid ? (
        <Text accessibilityLiveRegion="polite" style={{ color: "#a62525", fontSize: 13, writingDirection: direction ?? "auto" }}>
          {validity.message}
        </Text>
      ) : null}
    </View>
  );
}

const formInput = defineComponent({
  attributes: {
    label: { codec: stringCodec, prop: "label" },
    name: { codec: stringCodec, prop: "name" },
    required: { codec: presenceCodec, prop: "required" },
    value: { codec: stringCodec, prop: "value" },
  },
  children: "none",
  component: DemoFormInputComponent,
  schema: z.object({
    label: z.string(),
    name: z.string(),
    required: z.boolean().default(false),
    value: z.string(),
  }),
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
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={control.accessibilityState}
      disabled={control.disabled}
      onPress={() => {
        const submitter = control.selection();
        if (!formBinding.shouldInterceptSubmission({ submitter })) return;
        void formBinding
          .submit({
            protocol: { requestId: `demo-form-${encodeURIComponent(control.nodeKey)}-${++requestId.current}` },
            submitter,
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
      scrollRegion,
      flatListRegion,
      action,
      documentLink,
      form,
      formFieldset,
      formLegend,
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
  <DemoCard id="direction-card" dir="rtl" title="Native direction inheritance" style-tokens="tone:info space:compact">
    <DemoText>This text and card inherit the XML right-to-left direction.</DemoText>
    <DemoCard id="direction-ltr" dir="ltr" title="Explicit LTR override" style-tokens="space:compact">
      <DemoText>This nested card explicitly restores left-to-right direction.</DemoText>
    </DemoCard>
    <DemoCard id="direction-auto" dir="auto" title="Host-native automatic direction" style-tokens="space:compact">
      <DemoText>This text asks the native host to choose its writing direction.</DemoText>
    </DemoCard>
  </DemoCard>
  <DemoAction message="Hello from validated XML" />
  <DemoCard id="native-form-card" title="Live native form controls" style-tokens="tone:info space:compact">
    <DemoText>Clear the required first name to block submission and focus the first invalid native field. Restore a value, approve the host-owned native confirmation, then submit through the exact-form activity guard. The fixture fails its first safe GET so the registered form boundary can retry from current values with a fresh request ID.</DemoText>
    <DemoForm id="native-form" action="/demo/profile" method="post">
      <DemoFormInput id="first-name" autofocus="" label="First name" name="profile[first_name]" required="" value="Ada" />
      <DemoFormInput id="city" label="City" name="profile[city]" value="London" />
      <DemoFormFieldset id="disabled-profile-group" disabled="false">
        <DemoFormLegend>
          <DemoText>The first semantic legend remains enabled even when its fieldset is disabled.</DemoText>
          <DemoFormInput id="legend-note" label="Legend note" name="profile[legend_note]" value="Still included" />
        </DemoFormLegend>
        <DemoFormInput id="disabled-note" label="Disabled fieldset note" name="profile[disabled_note]" value="Omitted" />
      </DemoFormFieldset>
      <DemoFormSubmitter id="collect-form" data-turbo-confirm="Send this immutable preview?" data-turbo-submits-with="Submitting preview…" formaction="/demo/profile/preview" formmethod="get" label="Confirm and submit immutable request" name="commit" value="preview" />
    </DemoForm>
  </DemoCard>
  <DemoDocumentLink href="/demo/linked">
    <DemoText>Open a same-origin document through the app-owned native link.</DemoText>
  </DemoDocumentLink>
  <DemoDocumentLink href="/demo/linked" data-turbo-action="replace">
    <DemoText>Replace this Router entry with the linked document.</DemoText>
  </DemoDocumentLink>
  <DemoDocumentLink href="/demo/generated-link?source=gallery" data-turbo-method="post" data-turbo-confirm="Submit this generated form link?">
    <DemoText>Submit ordered link parameters through Turbo's generated-form path.</DemoText>
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
      <DemoDocumentLink href="/demo/frame-form" data-turbo-method="post" data-turbo-action="advance">
        <DemoText>Submit a generated form and promote this mounted Frame through shared history.</DemoText>
      </DemoDocumentLink>
    </DemoCard>
  </turbo-frame>
  <DemoCard id="nested-visibility-card" title="Nested lazy Frame visibility" style-tokens="tone:info space:compact">
    <DemoText>The nested region below owns a second clipping viewport. Its Frame remains idle until it is visible inside both this region and the gallery scroll view.</DemoText>
    <DemoScrollRegion id="nested-scroll-region">
      <DemoCard title="Nested offscreen content" style-tokens="space:comfortable">
        <DemoText>Scroll this inner region to reach its lazy Frame. The outer gallery and nested ScrollView both measure in window coordinates.</DemoText>
      </DemoCard>
      <DemoCard title="Nested spacer" style-tokens="space:comfortable">
        <DemoText>This intentionally keeps the Frame outside the nested viewport on initial render.</DemoText>
      </DemoCard>
      <turbo-frame id="nested-lazy-frame" loading="lazy" src="/demo/nested-frame">
        <DemoCard title="Nested Frame placeholder" style-tokens="tone:warning space:compact">
          <DemoText>The Frame loads only after it appears through every registered clipping region.</DemoText>
        </DemoCard>
      </turbo-frame>
    </DemoScrollRegion>
  </DemoCard>
  <DemoCard id="flatlist-visibility-card" title="Virtualized lazy Frame visibility" style-tokens="tone:info space:compact">
    <DemoText>Each horizontal FlatList row has one explicit Frame ID. A mounted buffered row remains idle until both its measured clipping geometry and native FlatList viewability membership admit it.</DemoText>
    <DemoFlatListRegion id="flatlist-frame-gallery" frame-ids='["flatlist-lazy-frame-one","flatlist-lazy-frame-two","flatlist-lazy-frame-three"]'><turbo-frame id="flatlist-lazy-frame-one" loading="lazy" src="/demo/flatlist/one">
        <DemoCard title="Virtualized Frame one" style-tokens="tone:warning space:compact">
          <DemoText>Swipe horizontally to admit this lazy Frame through FlatList viewability.</DemoText>
        </DemoCard>
      </turbo-frame><turbo-frame id="flatlist-lazy-frame-two" loading="lazy" src="/demo/flatlist/two">
        <DemoCard title="Virtualized Frame two" style-tokens="tone:warning space:compact">
          <DemoText>This buffered row must not load from geometry alone.</DemoText>
        </DemoCard>
      </turbo-frame><turbo-frame id="flatlist-lazy-frame-three" loading="lazy" src="/demo/flatlist/three">
        <DemoCard title="Virtualized Frame three" style-tokens="tone:warning space:compact">
          <DemoText>Recycled callbacks cannot make this row visible under a stale frame ID.</DemoText>
        </DemoCard>
      </turbo-frame></DemoFlatListRegion>
  </DemoCard>
  <turbo-frame id="preview-frame" src="/demo/frame" loading="lazy" autoscroll="" data-autoscroll-block="start" data-autoscroll-behavior="smooth">
    <DemoCard title="Frame boundary" style-tokens="tone:warning space:compact">
      <DemoText>The static renderer keeps the Frame in the protocol tree and renders its current children.</DemoText>
    </DemoCard>
  </turbo-frame>
</Gallery>`;
