import { serializeClientDescriptor } from "expo-turbo/core";
import {
  attr,
  component,
  defineRegistry,
  enumCodec,
  formOwner,
  jsonCodec,
  nodes,
  none,
  packageIdentity,
  presenceCodec,
  stringCodec,
  text as textChildren,
  tokenListCodec,
} from "expo-turbo/registry";
import packageManifest from "../package.json";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as ReactNative from "react-native";
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
import { useDemoAutofocusScrollTarget } from "./demo-autofocus-scroll";
import { DemoFlatListRegion, DemoNestedScrollRegion } from "./demo-boundaries";
import {
  pickDemoTextUpload,
  type DemoPickedTextUpload,
} from "./demo-document-picker";
import { useDemoFocusHandle } from "./demo-focus";
import { useDemoComponentStyle } from "./demo-style-runtime";
import {
  DEMO_CARD_BASE_STYLE,
  DEMO_CARD_TONE_STYLES,
  DEMO_STYLE_TOKENS,
} from "./demo-styles";
import { useDemoDocumentAnchorTarget } from "./demo-document-anchor-scroll";
import { useDemoDeviceTestScenario } from "./demo-device-test-control";
import {
  useDemoDeviceTestFocusProbe,
  useDemoDeviceTestSubmitProof,
} from "./demo-device-test-form-probes";

function nativeLayoutDirection(
  direction: ExpoTurboDirection | undefined,
): "inherit" | "ltr" | "rtl" {
  return direction === "ltr" || direction === "rtl" ? direction : "inherit";
}

const flatListFrameIds = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(8)
  .readonly();

function DemoFormSurface({ children }: { children?: ReactNode }) {
  const form = useExpoTurboForm();
  return (
    <View
      accessibilityLabel={form.state.busy ? "Form submitting" : "Form ready"}
      accessibilityState={form.accessibilityState}
      accessible={false}
      role="form"
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

const DEMO_UPLOAD_CONTENT = "Expo Turbo native multipart upload\n";

function DemoNativeSwitch({
  accessibilityLabel,
  accessibilityState,
  disabled,
  onValueChange,
  value,
}: {
  accessibilityLabel: string;
  accessibilityState: Readonly<{ checked: boolean; disabled: boolean }>;
  disabled: boolean;
  onValueChange(value: boolean): void;
  value: boolean;
}) {
  const NativeSwitch = ReactNative.Switch;
  if (NativeSwitch) {
    return (
      <NativeSwitch
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        disabled={disabled}
        onValueChange={onValueChange}
        value={value}
      />
    );
  }
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="switch"
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
    >
      <Text>{value ? "On" : "Off"}</Text>
    </Pressable>
  );
}

type DemoPlan = "none" | "starter" | "pro";

export const DEMO_REGISTRY = defineRegistry({
  package: packageIdentity(packageManifest),
  components: {
    Gallery: component({
      children: nodes,
      render: function Gallery({ children }) {
        const direction = useExpoTurboDirection();
        return (
          <View
            style={[
              { gap: 12 },
              { direction: nativeLayoutDirection(direction) },
            ]}
          >
            {children}
          </View>
        );
      },
    }),
    DemoCard: component({
      attributes: {
        title: attr(stringCodec),
        tone: attr(enumCodec(["positive", "warning"])).optional(),
      },
      children: nodes,
      render: function DemoCard({ children, styleTokens, title, tone }) {
        const direction = useExpoTurboDirection();
        const resolvedStyle = useDemoComponentStyle({
          component: DEMO_CARD_BASE_STYLE,
          ...(tone ? { props: DEMO_CARD_TONE_STYLES[tone] } : {}),
          tokens: styleTokens,
        });
        return (
          <View
            style={[
              resolvedStyle,
              { direction: nativeLayoutDirection(direction) },
            ]}
          >
            <Text
              selectable
              style={{
                fontSize: 17,
                fontWeight: "600",
                writingDirection: direction ?? "auto",
              }}
            >
              {title}
            </Text>
            {children}
          </View>
        );
      },
      styles: attr(
        tokenListCodec("demo-style", DEMO_STYLE_TOKENS, {
          maxTokens: 5,
        }),
      ).default([]),
    }),
    DemoText: component({
      // `p` is the HTML spelling of this component. The Rails demo declares
      // the same alias, so one template serves a browser a paragraph and this
      // client a DemoText.
      aliases: ["p"],
      children: textChildren,
      render: function DemoText({ children }) {
        const direction = useExpoTurboDirection();
        return (
          <Text
            selectable
            style={{
              color: "#435160",
              fontSize: 14,
              lineHeight: 21,
              writingDirection: direction ?? "auto",
            }}
          >
            {children}
          </Text>
        );
      },
    }),
    DemoScrollRegion: component({
      attributes: { id: attr(stringCodec, z.string().trim().min(1)) },
      children: nodes,
      render(props) {
        return <DemoNestedScrollRegion {...props} />;
      },
    }),
    DemoFlatListRegion: component({
      attributes: {
        "frame-ids": attr(
          jsonCodec("demo-flat-list-frame-ids", flatListFrameIds, {
            maxBytes: 512,
          }),
        ),
        id: attr(stringCodec, z.string().trim().min(1)),
      },
      children: nodes,
      render(props) {
        return <DemoFlatListRegion {...props} />;
      },
    }),
    DemoAction: component({
      attributes: { message: attr(stringCodec) },
      children: none,
      render: function DemoAction({ message }) {
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
      },
    }),
    DemoDocumentLink: component({
      attributes: {
        "accessibility-label": attr(
          stringCodec,
          z.string().trim().min(1),
        ).optional(),
        disabled: attr(presenceCodec).default(false),
        href: attr(stringCodec, z.string().trim().min(1)),
      },
      children: nodes,
      render: function DemoDocumentLink({ accessibilityLabel, children, disabled, href }) {
        const activate = useExpoTurboDocumentLink(href);
        const prefetch = useExpoTurboDocumentLinkPrefetch(href);
        const [error, setError] = useState<string>();
        const [pending, setPending] = useState(false);
        const unavailable = disabled || pending;
        return (
          <View style={{ gap: 6 }}>
            <Pressable
              accessibilityLabel={accessibilityLabel}
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
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : "Document visit failed",
                    );
                  })
                  .finally(() => setPending(false));
              }}
              testID={
                accessibilityLabel
                  ? `demo-document-link-${accessibilityLabel
                      .toLowerCase()
                      .replaceAll(/[^a-z0-9]+/g, "-")
                      .replaceAll(/^-|-$/g, "")}`
                  : undefined
              }
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
      },
    }),
    DemoAnchorTarget: component({
      attributes: { id: attr(stringCodec, z.string().trim().min(1)) },
      children: nodes,
      render: function DemoAnchorTarget({ children, id }) {
        const { onLayout, setNativeTarget } = useDemoDocumentAnchorTarget(id);
        return (
          <View
            collapsable={false}
            onLayout={onLayout}
            ref={setNativeTarget}
            testID={`demo-anchor-target-${id}`}
          >
            {children}
          </View>
        );
      },
    }),
    DemoStreamMorphProbe: component({
      attributes: {
        "increment-label": attr(
          stringCodec,
          z.string().trim().min(1),
        ).optional(),
        message: attr(stringCodec, z.string().trim().min(1)),
      },
      children: none,
      render: function DemoStreamMorphProbe({
        incrementLabel = "Increment HTTP Stream morph counter",
        message,
      }) {
        const [count, setCount] = useState(0);
        return (
          <View
            accessibilityLabel="Rails HTTP Stream morph proof"
            style={{ gap: 6 }}
          >
            <Text
              accessibilityLabel={message}
              selectable
              style={{ color: "#435160", fontSize: 14 }}
            >
              {message}
            </Text>
            <Text
              accessibilityLabel={`Local count: ${count}`}
              selectable
              style={{ color: "#435160", fontSize: 13 }}
              testID="demo-http-stream-morph-count"
            >
              Local count: {count}
            </Text>
            <Pressable
              accessibilityLabel={incrementLabel}
              accessibilityRole="button"
              onPress={() => setCount((current) => current + 1)}
              style={({ pressed }) => ({
                alignSelf: "flex-start",
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text
                style={{ color: "#0a5ca8", fontSize: 14, fontWeight: "600" }}
              >
                Increment local count
              </Text>
            </Pressable>
          </View>
        );
      },
    }),
    DemoForm: component({
      children: nodes,
      render({ children }) {
        return (
          <ExpoTurboFormScope>
            <DemoFormSurface>{children}</DemoFormSurface>
          </ExpoTurboFormScope>
        );
      },
      role: formOwner,
    }),
    DemoFormFieldset: component({
      attributes: { disabled: attr(presenceCodec).default(false) },
      children: nodes,
      render({ children, disabled }) {
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
      },
      role: "fieldset",
    }),
    DemoFormLegend: component({
      children: nodes,
      render({ children }) {
        return <View style={{ gap: 8 }}>{children}</View>;
      },
      role: "legend",
    }),
    DemoFormInput: component({
      attributes: {
        label: attr(stringCodec),
        name: attr(stringCodec),
        required: attr(presenceCodec).default(false),
        value: attr(stringCodec),
      },
      children: none,
      render: function DemoFormInput({ label, name, required, value }) {
        const deviceTest = useDemoDeviceTestScenario();
        const direction = useExpoTurboDirection();
        const [current, setCurrent] = useState(value);
        const fieldRef = useRef<ReactNative.View>(null);
        const inputRef = useRef<TextInput>(null);
        const validation = required
          ? z.string().trim().min(1, `${label} is required`).safeParse(current)
          : undefined;
        const validity =
          validation === undefined || validation.success
            ? ({ valid: true } as const)
            : ({
                message:
                  validation.error.issues[0]?.message ?? `${label} is invalid`,
                valid: false,
              } as const);
        const control = useExpoTurboFormControl({
          kind: "value",
          name,
          value: current,
          ...(required ? { validity } : {}),
        });
        const focusHandlers = useDemoFocusHandle(control.nodeKey, inputRef);
        const autofocusScroll = useDemoAutofocusScrollTarget(
          control.nodeKey,
          fieldRef,
        );
        const focusProbe = useDemoDeviceTestFocusProbe(
          deviceTest,
          `demo-form-focus-probe-${control.nodeKey.replaceAll(":", "-")}`,
        );
        return (
          <View
            collapsable={false}
            onLayout={autofocusScroll.onLayout}
            ref={fieldRef}
            style={{ direction: nativeLayoutDirection(direction), gap: 6 }}
            testID={`demo-form-field-${control.nodeKey.replaceAll(":", "-")}`}
          >
            <Text
              style={{
                color: "#435160",
                fontSize: 13,
                writingDirection: direction ?? "auto",
              }}
            >
              {label}
            </Text>
            <TextInput
              accessibilityHint={!validity.valid ? validity.message : undefined}
              accessibilityLabel={label}
              accessibilityState={control.accessibilityState}
              editable={!control.disabled}
              onBlur={() => {
                autofocusScroll.onBlur();
                focusHandlers.onBlur();
                focusProbe.onActualBlur();
              }}
              onChangeText={setCurrent}
              onFocus={() => {
                focusHandlers.onFocus();
                autofocusScroll.onFocus();
                focusProbe.onActualFocus();
              }}
              ref={inputRef}
              style={{
                backgroundColor: control.disabled ? "#f6f8fa" : "white",
                borderColor: validity.valid ? "#9eb0c3" : "#a62525",
                borderRadius: 10,
                borderWidth: 1,
                color: "#172230",
                paddingHorizontal: 12,
                paddingVertical: 10,
                writingDirection: direction ?? "auto",
              }}
              testID={`demo-form-input-${control.nodeKey.replaceAll(":", "-")}`}
              value={current}
            />
            {focusProbe.probe}
            {!validity.valid ? (
              <Text
                accessibilityLiveRegion="polite"
                style={{
                  color: "#a62525",
                  fontSize: 13,
                  writingDirection: direction ?? "auto",
                }}
              >
                {validity.message}
              </Text>
            ) : null}
          </View>
        );
      },
    }),
    DemoFormFile: component({
      attributes: {
        error: attr(stringCodec, z.string().trim().min(1)).optional(),
        filename: attr(stringCodec, z.string().trim().min(1)),
        label: attr(stringCodec, z.string().trim().min(1)),
        name: attr(stringCodec, z.string().trim().min(1)),
      },
      children: none,
      render: function DemoFormFile({ error, filename, label, name }) {
        const mounted = useRef(true);
        // A rejected matching Frame response replaces this component. Keep the
        // intentionally bounded picker result with the document so retrying does
        // not make an iOS user choose the same file again.
        const pickedState = useDocumentState<DemoPickedTextUpload>(
          "demo-upload-attachment",
        );
        const picked = pickedState.value;
        const [pickerError, setPickerError] = useState<string>();
        const [selecting, setSelecting] = useState(false);
        const fallbackAttachment = useMemo(
          () => ({
            blob: new Blob([DEMO_UPLOAD_CONTENT], { type: "text/plain" }),
            filename,
          }),
          [filename],
        );
        const attachment = picked?.attachment ?? fallbackAttachment;
        const control = useExpoTurboFormControl({
          entries: [{ name, value: attachment }],
          kind: "entries",
        });
        const disabled = control.disabled || selecting;
        const displayedError = pickerError ?? error;
        const selectedFilename = attachment.filename;
        useEffect(() => {
          mounted.current = true;
          return () => {
            mounted.current = false;
          };
        }, []);

        const chooseFile = () => {
          if (disabled) return;
          setPickerError(undefined);
          setSelecting(true);
          void pickDemoTextUpload()
            .then((next) => {
              if (next && mounted.current) pickedState.set(next);
            })
            .catch((error: unknown) => {
              if (!mounted.current) return;
              setPickerError(
                error instanceof Error
                  ? error.message
                  : "Unable to select a text file",
              );
            })
            .finally(() => {
              if (mounted.current) setSelecting(false);
            });
        };

        return (
          <View
            accessibilityHint={displayedError}
            accessibilityLabel={`${label}: ${selectedFilename}`}
            accessibilityState={control.accessibilityState}
            style={{ gap: 4, opacity: disabled ? 0.55 : 1 }}
          >
            <Text style={{ color: "#435160", fontSize: 13 }}>{label}</Text>
            <Text selectable style={{ color: "#172230", fontSize: 14 }}>
              {picked ? "Selected" : "Ready"}: {selectedFilename}
            </Text>
            <Pressable
              accessibilityLabel={`Choose ${label}`}
              accessibilityRole="button"
              accessibilityState={{ busy: selecting, disabled }}
              disabled={disabled}
              onPress={chooseFile}
              style={{ alignSelf: "flex-start", opacity: disabled ? 0.55 : 1 }}
            >
              <Text
                style={{ color: "#0a5ca8", fontSize: 14, fontWeight: "600" }}
              >
                {selecting ? "Opening Files…" : "Choose a text file"}
              </Text>
            </Pressable>
            {displayedError ? (
              <Text
                accessibilityLiveRegion="polite"
                style={{ color: "#a62525", fontSize: 13 }}
              >
                {displayedError}
              </Text>
            ) : null}
          </View>
        );
      },
    }),
    DemoFormCheckbox: component({
      attributes: {
        checked: attr(presenceCodec).default(false),
        error: attr(stringCodec, z.string().trim().min(1)).optional(),
        label: attr(stringCodec, z.string().trim().min(1)),
        name: attr(stringCodec, z.string().trim().min(1)),
        value: attr(stringCodec),
      },
      children: none,
      render: function DemoFormCheckbox({ checked, error, label, name, value }) {
        const [current, setCurrent] = useState(checked);
        const control = useExpoTurboFormControl({
          checked: current,
          kind: "checkable",
          name,
          value,
        });
        return (
          <View
            accessibilityHint={error}
            accessibilityState={{
              ...control.accessibilityState,
              checked: current,
            }}
            style={{ gap: 4, opacity: control.disabled ? 0.55 : 1 }}
          >
            <DemoNativeSwitch
              accessibilityLabel={label}
              accessibilityState={{
                ...control.accessibilityState,
                checked: current,
              }}
              disabled={control.disabled}
              onValueChange={setCurrent}
              value={current}
            />
            <Text style={{ color: "#172230", fontSize: 14 }}>{label}</Text>
            {error ? (
              <Text
                accessibilityLiveRegion="polite"
                style={{ color: "#a62525", fontSize: 13 }}
              >
                {error}
              </Text>
            ) : null}
          </View>
        );
      },
    }),
    DemoFormPlanSelect: component({
      attributes: {
        error: attr(stringCodec, z.string().trim().min(1)).optional(),
        label: attr(stringCodec, z.string().trim().min(1)),
        name: attr(stringCodec, z.string().trim().min(1)),
        selected: attr(enumCodec(["none", "starter", "pro"])),
      },
      children: none,
      render: function DemoFormPlanSelect({ error, label, name, selected }) {
        const [current, setCurrent] = useState(selected);
        const control = useExpoTurboFormControl({
          kind: "select",
          name,
          options: [
            {
              kind: "option",
              selected: current === "starter",
              value: "starter",
            },
            { kind: "option", selected: current === "pro", value: "pro" },
          ],
        });
        const option = (
          value: Exclude<DemoPlan, "none">,
          optionLabel: string,
        ) => {
          const isSelected = current === value;
          return (
            <Pressable
              accessibilityLabel={optionLabel}
              accessibilityRole="radio"
              accessibilityState={{
                ...control.accessibilityState,
                selected: isSelected,
              }}
              disabled={control.disabled}
              key={value}
              onPress={() => setCurrent(value)}
              style={{
                backgroundColor: isSelected ? "#d7e8fa" : "white",
                borderColor: isSelected ? "#285589" : "#9eb0c3",
                borderRadius: 10,
                borderWidth: 1,
                opacity: control.disabled ? 0.55 : 1,
                padding: 10,
              }}
            >
              <Text
                style={{
                  color: "#172230",
                  fontSize: 14,
                  fontWeight: isSelected ? "600" : "400",
                }}
              >
                {optionLabel}
              </Text>
            </Pressable>
          );
        };
        return (
          <View accessibilityHint={error} style={{ gap: 6 }}>
            <Text style={{ color: "#435160", fontSize: 13 }}>{label}</Text>
            <View accessibilityLabel={label} style={{ gap: 6 }}>
              {option("starter", "Starter plan")}
              {option("pro", "Pro plan")}
            </View>
            {error ? (
              <Text
                accessibilityLiveRegion="polite"
                style={{ color: "#a62525", fontSize: 13 }}
              >
                {error}
              </Text>
            ) : null}
          </View>
        );
      },
    }),
    DemoFormSubmitter: component({
      attributes: {
        formaction: attr(stringCodec).optional(),
        formenctype: attr(stringCodec).optional(),
        formmethod: attr(stringCodec).optional(),
        label: attr(stringCodec),
        name: attr(stringCodec),
        value: attr(stringCodec),
      },
      children: none,
      render: function DemoFormSubmitter(props) {
        const deviceTest = useDemoDeviceTestScenario();
        const { label, name, value } = props;
        const formBinding = useExpoTurboForm();
        const control = useExpoTurboFormControl({
          kind: "submitter",
          name,
          value,
        });
        const loadingObserved = useDocumentState<boolean>(
          `demo-submission-loading-observed:${control.nodeKey}`,
        );
        const requestId = useRef(0);
        const submitProof = useDemoDeviceTestSubmitProof(
          deviceTest,
          `demo-form-submit-proof-${control.nodeKey.replaceAll(":", "-")}`,
        );
        useEffect(() => {
          if (control.submitsWith) loadingObserved.set(true);
        }, [control.submitsWith, loadingObserved]);
        return (
          <View style={{ gap: 4 }}>
            <Pressable
              accessibilityLabel={label}
              accessibilityRole="button"
              accessibilityState={control.accessibilityState}
              disabled={control.disabled}
              onPress={() => {
                const submitter = control.selection();
                if (!formBinding.shouldInterceptSubmission({ submitter }))
                  return;
                const submission = formBinding.submit({
                  protocol: {
                    requestId: `demo-form-${encodeURIComponent(control.nodeKey)}-${++requestId.current}`,
                  },
                  submitter,
                });
                void (deviceTest ? submitProof.observe(submission) : submission).catch(
                  () => undefined,
                );
              }}
              testID={`demo-form-submitter-${control.nodeKey.replaceAll(":", "-")}`}
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
            {submitProof.probe}
            {loadingObserved.value ? (
              <Text
                accessibilityLiveRegion="polite"
                style={{ color: "#435160", fontSize: 13 }}
              >
                Submission loading state observed
              </Text>
            ) : null}
          </View>
        );
      },
    }),
  },
});

export const DEMO_MODULE_VERSIONS = serializeClientDescriptor(DEMO_REGISTRY.capabilities.hash);

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
    <DemoForm id="native-form" action="/demo/profile" dir="rtl" method="post">
      <DemoFormInput id="first-name" autofocus="" dir="auto" dirname="profile[first_name].dir" label="First name" name="profile[first_name]" required="" value="Ada" />
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
  <DemoDocumentLink href="/demo/linked?source=gallery&amp;tag=a&amp;tag=b&amp;empty=">
    <DemoText>Open a query-bearing same-origin document and retain repeated and empty values through native history.</DemoText>
  </DemoDocumentLink>
  <DemoDocumentLink href="/demo/linked?preview=automatic" data-turbo-preload="">
    <DemoText>Open a cached document preview, then replace it with the canonical response.</DemoText>
  </DemoDocumentLink>
  <DemoDocumentLink href="/demo/linked?prefetch=reuse">
    <DemoText>Reuse the native press-in response without a second document request.</DemoText>
  </DemoDocumentLink>
  <DemoDocumentLink href="/demo/linked?refresh=scroll">
    <DemoText>Open a Refresh Stream scenario and reset the owning root scroll after its canonical update.</DemoText>
  </DemoDocumentLink>
  <DemoDocumentLink href="/demo/linked?replace=morph">
    <DemoText>Open the same-path replace morph and root-scroll proof.</DemoText>
  </DemoDocumentLink>
  <DemoDocumentLink href="/demo/linked?autofocus=scroll">
    <DemoText>Open the root autofocus-scroll proof and focus the measured native field below the viewport.</DemoText>
  </DemoDocumentLink>
  <DemoDocumentLink href="/demo/routes/routing-proof/details?source=gallery&amp;tag=a&amp;tag=b&amp;empty=">
    <DemoText>Open a nested generic Router path and retain its ordered query metadata through native history.</DemoText>
  </DemoDocumentLink>
  <DemoDocumentLink href="#native-anchor-target">
    <DemoText>Jump to the registered native anchor target without a request or Router history write.</DemoText>
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
      <DemoAnchorTarget id="device-test-frame-promotion" />
      <DemoDocumentLink id="device-test-frame-promote" accessibility-label="Promote mounted Frame form" href="/demo/frame-form" data-turbo-method="post" data-turbo-action="advance">
        <DemoText>Submit a generated form and promote this mounted Frame through shared history.</DemoText>
      </DemoDocumentLink>
      <DemoDocumentLink href="#frame-native-anchor-target">
        <DemoText>Jump within this Frame to its registered native anchor target.</DemoText>
      </DemoDocumentLink>
      <DemoDocumentLink
        data-turbo-preload=""
        href="/demo/frame-linked?preview=automatic#frame-linked-fragment-target"
      >
        <DemoText>Use the preloaded Frame response, then jump to its fragment target.</DemoText>
      </DemoDocumentLink>
      <DemoCard title="Frame anchor spacer" style-tokens="space:comfortable">
        <DemoText>This spacer keeps the Frame-owned target below its activation link.</DemoText>
      </DemoCard>
      <DemoAnchorTarget id="frame-native-anchor-target">
        <DemoCard title="Frame native anchor target" tone="positive" style-tokens="space:comfortable surface:elevated">
          <DemoText>The link and target share the same current Frame and started no Frame request.</DemoText>
        </DemoCard>
      </DemoAnchorTarget>
    </DemoCard>
  </turbo-frame>
  <DemoDocumentLink href="#frame-native-anchor-target" data-turbo-frame="link-frame">
    <DemoText>Jump from the document into the named Frame anchor target.</DemoText>
  </DemoDocumentLink>
  <DemoCard id="nested-visibility-card" title="Nested lazy Frame visibility" style-tokens="tone:info space:compact">
    <DemoText>The nested region below owns a second clipping viewport. Its Frame remains idle until it is visible inside both this region and the gallery scroll view.</DemoText>
    <DemoScrollRegion id="nested-scroll-region">
      <DemoCard title="Nested offscreen content" style-tokens="space:comfortable">
        <DemoDocumentLink href="#nested-native-anchor-target">
          <DemoText>Jump within this nested ScrollView to its registered anchor target.</DemoText>
        </DemoDocumentLink>
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
      <DemoAnchorTarget id="nested-native-anchor-target">
        <DemoCard title="Nested native anchor target" tone="positive" style-tokens="space:comfortable surface:elevated">
          <DemoText>The example-owned anchor registry scrolled only this declared nested container.</DemoText>
        </DemoCard>
      </DemoAnchorTarget>
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
  <DemoAnchorTarget id="native-anchor-target">
    <DemoCard title="Native anchor target" tone="positive" style-tokens="space:comfortable surface:elevated">
      <DemoText>The root-only native adapter scrolled here without fetching, visiting, or mutating Router history.</DemoText>
    </DemoCard>
  </DemoAnchorTarget>
  <DemoCard id="history-scroll-marker" title="Native history scroll checkpoint" tone="positive" style-tokens="space:comfortable surface:elevated">
    <DemoText>Open the next document, then use the native iOS back action to return here at this root-scroll position from cached history.</DemoText>
    <DemoDocumentLink href="/demo/linked?history=scroll">
      <DemoText>Open the native history scroll restoration proof.</DemoText>
    </DemoDocumentLink>
  </DemoCard>
</Gallery>`;
