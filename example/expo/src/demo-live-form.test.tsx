/// <reference types="bun" />

import { expect, mock, test } from "bun:test";
import { attributeValue, EXPO_TURBO_MIME_TYPE } from "expo-turbo/core";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DemoLiveFetchRequest } from "./demo-live-transport";

interface PressableProps {
  readonly accessibilityLabel?: string;
  readonly accessibilityRole?: string;
  readonly onPress?: () => void;
}

interface SwitchProps {
  readonly accessibilityLabel?: string;
  readonly onValueChange?: (value: boolean) => void;
  readonly value?: boolean;
}

let pickerResult: unknown = Object.freeze({ assets: Object.freeze([]), canceled: true });

mock.module("expo-document-picker", () => ({
  getDocumentAsync: async () => pickerResult,
}));

mock.module("expo-file-system", () => ({
  File: class ExpoFile extends Blob {
    constructor(_uri: string) {
      super(["picked from Files\n"], { type: "text/plain" });
    }
  },
}));

mock.module("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Alert: { alert: () => undefined },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  FlatList: (props: Readonly<Record<string, unknown>>) => createElement("flat-list", props),
  Linking: { openURL: async () => undefined },
  Platform: { OS: "web" },
  Pressable: (props: PressableProps) => createElement("pressable", props),
  ScrollView: (props: Readonly<Record<string, unknown>>) => createElement("scroll-view", props),
  Switch: (props: SwitchProps) => createElement("switch", props),
  Text: (props: Readonly<Record<string, unknown>>) => createElement("native-text", props),
  TextInput: (props: Readonly<Record<string, unknown>>) => createElement("text-input", props),
  View: (props: Readonly<Record<string, unknown>>) => createElement("view", props),
}));

const { createDemoLiveFormRuntime, DemoLiveFormPanel } = await import("./demo-live-form");

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true;

const FORM_PATH = "/api/expo_turbo/demo/form";
const FRAME_ID = "demo-form-frame";
const TURBO_STREAM_MIME_TYPE = "text/vnd.turbo-stream.html";

interface PendingFetch {
  readonly request: DemoLiveFetchRequest;
  readonly resolve: (response: DemoLiveFetchResponse) => void;
  readonly url: string;
}

interface DemoLiveFetchResponse {
  readonly headers: Readonly<{
    forEach(callback: (value: string, name: string) => void): void;
  }>;
  readonly redirected: boolean;
  readonly status: number;
  readonly url: string;
  text(): Promise<string>;
}

function response(
  body: string,
  options: Readonly<{ contentType?: string; redirected?: boolean; status: number; url: string }>,
): DemoLiveFetchResponse {
  return Object.freeze({
    headers: Object.freeze({
      forEach(callback: (value: string, name: string) => void): void {
        callback(options.contentType ?? EXPO_TURBO_MIME_TYPE, "Content-Type");
      },
    }),
    redirected: options.redirected ?? false,
    status: options.status,
    text: async () => body,
    url: options.url,
  });
}

function formXml(
  firstName: string,
  error?: string,
  uploadError?: string,
  termsAccepted = false,
  termsError?: string,
  planSelected: "none" | "starter" | "pro" = "none",
  planError?: string,
): string {
  return `<turbo-frame id="${FRAME_ID}"><DemoForm id="demo-form" action="${FORM_PATH}" method="post"><DemoText id="demo-form-title">Rails Frame form</DemoText><DemoFormInput id="demo-form-first-name" label="First name" name="profile[first_name]" value="${firstName}" />${error ? `<DemoText id="demo-form-error">${error}</DemoText>` : ""}<DemoFormSubmitter id="demo-form-submit" label="Save first name" name="commit" value="save" /><DemoFormSubmitter id="demo-form-preserve-local" label="Save name and preserve local draft" name="commit" value="save-morph" /><DemoFormSubmitter id="demo-form-complete" label="Complete without replacing Frame" name="commit" value="no-content" /></DemoForm><DemoForm id="demo-upload-form" action="${FORM_PATH}" enctype="multipart/form-data" method="post"><DemoFormFile id="demo-form-attachment" label="Sample attachment" name="profile[attachment]" filename="expo-turbo-upload.txt"${uploadError ? ` error="${uploadError}"` : ""} /><DemoFormSubmitter id="demo-form-upload" label="Upload sample attachment" name="commit" value="upload" /><DemoFormSubmitter id="demo-form-upload-retry" label="Validate selected attachment (return 422)" name="commit" value="upload-retry" /></DemoForm><DemoForm id="demo-consent-form" action="${FORM_PATH}" method="post"><DemoFormCheckbox id="demo-form-terms" label="Accept demo terms" name="profile[terms]" value="accepted"${termsAccepted ? " checked" : ""}${termsError ? ` error="${termsError}"` : ""} /><DemoFormSubmitter id="demo-form-consent" label="Save consent" name="commit" value="save-consent" /></DemoForm><DemoForm id="demo-plan-form" action="${FORM_PATH}" method="post"><DemoFormPlanSelect id="demo-form-plan" label="Demo plan" name="profile[plan]" selected="${planSelected}"${planError ? ` error="${planError}"` : ""} /><DemoFormSubmitter id="demo-form-plan-submit" label="Save plan" name="commit" value="save-plan" /></DemoForm></turbo-frame>`;
}

function morphValidationStream(error: string): string {
  return `<turbo-stream action="replace" target="demo-form" method="morph"><template><DemoForm id="demo-form" action="${FORM_PATH}" method="post"><DemoText id="demo-form-title">Rails Frame form</DemoText><DemoFormInput id="demo-form-first-name" label="First name" name="profile[first_name]" value="" /><DemoText id="demo-form-error">${error}</DemoText><DemoFormSubmitter id="demo-form-submit" label="Save first name" name="commit" value="save" /><DemoFormSubmitter id="demo-form-preserve-local" label="Save name and preserve local draft" name="commit" value="save-morph" /><DemoFormSubmitter id="demo-form-complete" label="Complete without replacing Frame" name="commit" value="no-content" /></DemoForm></template></turbo-stream>`;
}

function takePending(pending: PendingFetch[], message: string): PendingFetch {
  const next = pending.shift();
  if (!next) throw new Error(message);
  return next;
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("renders the bounded Rails Frame form panel through validation, no-content, and canonical recovery", async () => {
  const origin = "http://demo.example:3001";
  const formUrl = new URL(FORM_PATH, origin).toString();
  const pending: PendingFetch[] = [];
  const proof = createDemoLiveFormRuntime({
    fetch: (url, request) =>
      new Promise<DemoLiveFetchResponse>((resolve) => {
        pending.push(Object.freeze({ request, resolve, url }));
      }),
    origin,
  });
  let renderer: ReactTestRenderer | undefined;
  const submitter = (label: string) => {
    const rendered = renderer?.root.findByProps({ accessibilityLabel: label });
    if (!rendered?.props.onPress) throw new Error(`The ${label} submitter did not render`);
    return rendered.props as PressableProps;
  };

  try {
    act(() => {
      renderer = create(createElement(DemoLiveFormPanel, { proof }), {
        createNodeMock: (element) =>
          element.type === "text-input"
            ? { blur: () => undefined, focus: () => undefined }
            : {},
      });
    });

    expect(JSON.stringify(renderer?.toJSON())).toContain("Standalone Rails Frame form");
    const initial = takePending(pending, "The mounted Frame did not request the Rails form");
    expect(initial).toMatchObject({
      request: {
        headers: { Accept: EXPO_TURBO_MIME_TYPE, "Turbo-Frame": FRAME_ID },
        method: "GET",
      },
      url: formUrl,
    });
    await act(async () => {
      initial.resolve(response(formXml(""), { status: 200, url: formUrl }));
      await Promise.resolve();
    });
    await proof.frames.get(FRAME_ID).loaded;
    const firstName = renderer?.root.findByProps({ accessibilityLabel: "First name" });
    expect(firstName?.props.testID).toBe("demo-form-input-id-demo-form-first-name");
    expect(firstName?.props.value).toBe("");
    expect(
      renderer?.root.findByProps({
        accessibilityLabel: "Sample attachment: expo-turbo-upload.txt",
      }),
    ).toBeDefined();
    expect(renderer?.root.findByProps({ accessibilityLabel: "Accept demo terms" }).props.value).toBe(false);
    expect(renderer?.root.findByProps({ accessibilityLabel: "Starter plan" }).props.accessibilityState).toMatchObject({
      selected: false,
    });
    expect(renderer?.root.findByProps({ accessibilityLabel: "Pro plan" }).props.accessibilityState).toMatchObject({
      selected: false,
    });

    act(() => {
      submitter("Save consent").onPress?.();
    });
    const missingConsent = takePending(pending, "The unchecked consent control did not submit");
    expect(missingConsent).toMatchObject({
      request: {
        body: "commit=save-consent",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Turbo-Frame": FRAME_ID,
        },
        method: "POST",
      },
      url: formUrl,
    });
    await act(async () => {
      missingConsent.resolve(
        response(formXml("", undefined, undefined, false, "Accept the demo terms before saving"), {
          status: 422,
          url: formUrl,
        }),
      );
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer?.toJSON())).toContain("Accept the demo terms before saving");
    const consent = renderer?.root.findByProps({ accessibilityLabel: "Accept demo terms" });
    expect(consent?.props.value).toBe(false);

    await act(async () => {
      consent?.props.onValueChange?.(true);
      await Promise.resolve();
    });
    expect(renderer?.root.findByProps({ accessibilityLabel: "Accept demo terms" }).props.value).toBe(true);
    act(() => {
      submitter("Save consent").onPress?.();
    });
    const acceptedConsent = takePending(pending, "The checked consent control did not submit");
    expect(acceptedConsent).toMatchObject({
      request: {
        body: "profile%5Bterms%5D=accepted&commit=save-consent",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Turbo-Frame": FRAME_ID,
        },
        method: "POST",
      },
      url: formUrl,
    });
    await act(async () => {
      acceptedConsent.resolve(response(formXml(""), { redirected: true, status: 200, url: formUrl }));
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer?.toJSON())).not.toContain("Accept the demo terms before saving");

    act(() => {
      submitter("Save plan").onPress?.();
    });
    const missingPlan = takePending(pending, "The unselected plan control did not submit");
    expect(missingPlan).toMatchObject({
      request: {
        body: "commit=save-plan",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Turbo-Frame": FRAME_ID,
        },
        method: "POST",
      },
      url: formUrl,
    });
    await act(async () => {
      missingPlan.resolve(
        response(formXml("", undefined, undefined, false, undefined, "none", "Choose a supported demo plan"), {
          status: 422,
          url: formUrl,
        }),
      );
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer?.toJSON())).toContain("Choose a supported demo plan");
    act(() => {
      renderer?.root.findByProps({ accessibilityLabel: "Pro plan" }).props.onPress?.();
    });
    expect(renderer?.root.findByProps({ accessibilityLabel: "Pro plan" }).props.accessibilityState).toMatchObject({
      selected: true,
    });
    act(() => {
      submitter("Save plan").onPress?.();
    });
    const acceptedPlan = takePending(pending, "The selected plan control did not submit");
    expect(acceptedPlan).toMatchObject({
      request: {
        body: "profile%5Bplan%5D=pro&commit=save-plan",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Turbo-Frame": FRAME_ID,
        },
        method: "POST",
      },
      url: formUrl,
    });
    await act(async () => {
      acceptedPlan.resolve(response(formXml(""), { redirected: true, status: 200, url: formUrl }));
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer?.toJSON())).not.toContain("Choose a supported demo plan");
    expect(renderer?.root.findByProps({ accessibilityLabel: "Pro plan" }).props.accessibilityState).toMatchObject({
      selected: false,
    });

    const pickedAttachment = new Blob(["picked from Files\n"], { type: "text/plain" });
    pickerResult = Object.freeze({
      assets: Object.freeze([
        Object.freeze({
          file: pickedAttachment,
          lastModified: 0,
          mimeType: "text/plain",
          name: "picked-notes.txt",
          size: pickedAttachment.size,
          uri: "file:///cache/picked-notes.txt",
        }),
      ]),
      canceled: false,
    });
    await act(async () => {
      renderer?.root.findByProps({ accessibilityLabel: "Choose Sample attachment" }).props.onPress?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      renderer?.root.findByProps({ accessibilityLabel: "Sample attachment: picked-notes.txt" }),
    ).toBeDefined();

    act(() => {
      submitter("Validate selected attachment (return 422)").onPress?.();
    });
    const upload = takePending(pending, "The rendered form did not submit its multipart attachment");
    expect(upload).toMatchObject({
      request: {
        headers: {
          Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
          "Turbo-Frame": FRAME_ID,
        },
        method: "POST",
      },
      url: formUrl,
    });
    expect(upload.request.headers["Content-Type"]).toBeUndefined();
    if (!(upload.request.body instanceof FormData)) {
      throw new Error("The multipart request did not reach the host as FormData");
    }
    expect(upload.request.body.get("commit")).toBe("upload-retry");
    const attachment = upload.request.body.get("profile[attachment]");
    if (!(attachment instanceof Blob)) throw new Error("The multipart request omitted its Blob");
    expect(await attachment.text()).toBe("picked from Files\n");
    expect((attachment as Blob & { name?: string }).name).toBe("picked-notes.txt");
    await act(async () => {
      upload.resolve(
        response(formXml("", undefined, "Retry this selected attachment"), {
          status: 422,
          url: formUrl,
        }),
      );
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer?.toJSON())).toContain("Retry this selected attachment");
    expect(
      renderer?.root.findByProps({ accessibilityLabel: "Sample attachment: picked-notes.txt" }),
    ).toBeDefined();

    act(() => {
      submitter("Upload sample attachment").onPress?.();
    });
    const retryUpload = takePending(pending, "The selected attachment was not retained for retry");
    if (!(retryUpload.request.body instanceof FormData)) {
      throw new Error("The retained multipart request did not reach the host as FormData");
    }
    const retainedAttachment = retryUpload.request.body.get("profile[attachment]");
    if (!(retainedAttachment instanceof Blob)) {
      throw new Error("The retained multipart request omitted its Blob");
    }
    expect(await retainedAttachment.text()).toBe("picked from Files\n");
    expect((retainedAttachment as Blob & { name?: string }).name).toBe("picked-notes.txt");
    await act(async () => {
      retryUpload.resolve(response(formXml(""), { redirected: true, status: 200, url: formUrl }));
      await Promise.resolve();
    });

    await act(async () => {
      renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.onChangeText("Ada");
      await Promise.resolve();
    });
    const frameBeforeNoContent = proof.session.tree.getElementById(FRAME_ID);
    if (!frameBeforeNoContent) throw new Error("The mounted Rails Frame is missing");
    const childrenBeforeNoContent = frameBeforeNoContent.children;
    const revisionBeforeNoContent = proof.session.revision;
    act(() => {
      submitter("Complete without replacing Frame").onPress?.();
    });
    const noContent = takePending(pending, "The rendered form did not submit its no-content action");
    expect(noContent).toMatchObject({
      request: {
        body: "profile%5Bfirst_name%5D=Ada&commit=no-content",
        headers: {
          Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Turbo-Frame": FRAME_ID,
        },
        method: "POST",
      },
      url: formUrl,
    });
    await act(async () => {
      noContent.resolve(response("", { status: 204, url: formUrl }));
      await Promise.resolve();
    });
    expect(proof.session.tree.getElementById(FRAME_ID)).toBe(frameBeforeNoContent);
    expect(frameBeforeNoContent.children).toBe(childrenBeforeNoContent);
    expect(proof.session.revision).toBe(revisionBeforeNoContent);
    expect(renderer?.root.findAllByProps({ accessibilityLabel: "Form ready" }).length).toBeGreaterThan(0);
    expect(renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.value).toBe("Ada");

    await act(async () => {
      renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.onChangeText("invalid");
      await Promise.resolve();
    });
    act(() => {
      submitter("Save first name").onPress?.();
    });
    const invalid = takePending(pending, "The rendered form did not submit invalid values");
    expect(invalid).toMatchObject({
      request: {
        body: "profile%5Bfirst_name%5D=invalid&commit=save",
        headers: {
          Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Turbo-Frame": FRAME_ID,
        },
        method: "POST",
      },
      url: formUrl,
    });
    expect(invalid.request.headers["X-Turbo-Request-Id"]).not.toBe(
      noContent.request.headers["X-Turbo-Request-Id"],
    );
    await act(async () => {
      invalid.resolve(
        response(formXml("invalid", "This demo name is unavailable"), {
          status: 422,
          url: formUrl,
        }),
      );
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer?.toJSON())).toContain("This demo name is unavailable");
    expect(renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.value).toBe(
      "invalid",
    );
    const invalidFrame = proof.session.tree.getElementById(FRAME_ID);
    expect(invalidFrame && attributeValue(invalidFrame, "src")).toBe(formUrl);

    const formBeforeMorph = proof.session.tree.getElementById("demo-form");
    const inputBeforeMorph = proof.session.tree.getElementById("demo-form-first-name");
    if (!formBeforeMorph || !inputBeforeMorph) throw new Error("The invalid form did not remain addressable");
    await act(async () => {
      renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.onChangeText("invalid local draft");
      await Promise.resolve();
    });
    act(() => {
      submitter("Save name and preserve local draft").onPress?.();
    });
    const morphValidation = takePending(pending, "The rendered form did not submit its morph validation action");
    expect(morphValidation).toMatchObject({
      request: {
        body: "profile%5Bfirst_name%5D=invalid+local+draft&commit=save-morph",
        headers: {
          Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Turbo-Frame": FRAME_ID,
        },
        method: "POST",
      },
      url: formUrl,
    });
    await act(async () => {
      morphValidation.resolve(
        response(morphValidationStream("This demo name is unavailable"), {
          contentType: TURBO_STREAM_MIME_TYPE,
          status: 422,
          url: formUrl,
        }),
      );
      await Promise.resolve();
    });
    expect(proof.session.tree.getElementById("demo-form")).toBe(formBeforeMorph);
    expect(proof.session.tree.getElementById("demo-form-first-name")).toBe(inputBeforeMorph);
    expect(attributeValue(inputBeforeMorph, "value")).toBe("");
    expect(renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.value).toBe(
      "invalid local draft",
    );

    await act(async () => {
      renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.onChangeText("Ada");
      await Promise.resolve();
    });
    act(() => {
      submitter("Save first name").onPress?.();
    });
    const valid = takePending(pending, "The replacement form did not submit valid values");
    expect(valid).toMatchObject({
      request: {
        body: "profile%5Bfirst_name%5D=Ada&commit=save",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Turbo-Frame": FRAME_ID,
        },
        method: "POST",
      },
      url: formUrl,
    });
    await act(async () => {
      valid.resolve(response(formXml(""), { redirected: true, status: 200, url: formUrl }));
      await Promise.resolve();
    });
    expect(pending).toHaveLength(0);
    expect(JSON.stringify(renderer?.toJSON())).not.toContain("This demo name is unavailable");
    expect(renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.value).toBe("");
  } finally {
    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
    await nextTurn();
    expect(proof.forms.isDisposed).toBe(true);
    expect(proof.state.isDisposed).toBe(true);
    proof.dispose();
  }
});
