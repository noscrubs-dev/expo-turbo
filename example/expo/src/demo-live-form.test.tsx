/// <reference types="bun" />

import { expect, mock, test } from "bun:test";
import { attributeValue, EXPO_TURBO_MIME_TYPE } from "expo-turbo/core";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DemoLiveFetchRequest } from "./demo-live-transport";

interface PressableProps {
  readonly accessibilityRole?: string;
  readonly onPress?: () => void;
}

let latestPressable: PressableProps | undefined;

mock.module("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Alert: { alert: () => undefined },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  FlatList: (props: Readonly<Record<string, unknown>>) => createElement("flat-list", props),
  Linking: { openURL: async () => undefined },
  Platform: { OS: "web" },
  Pressable: (props: PressableProps) => {
    latestPressable = props;
    return createElement("pressable", props);
  },
  ScrollView: (props: Readonly<Record<string, unknown>>) => createElement("scroll-view", props),
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
  options: Readonly<{ redirected?: boolean; status: number; url: string }>,
): DemoLiveFetchResponse {
  return Object.freeze({
    headers: Object.freeze({
      forEach(callback: (value: string, name: string) => void): void {
        callback(EXPO_TURBO_MIME_TYPE, "Content-Type");
      },
    }),
    redirected: options.redirected ?? false,
    status: options.status,
    text: async () => body,
    url: options.url,
  });
}

function formXml(firstName: string, error?: string): string {
  return `<turbo-frame id="${FRAME_ID}"><DemoForm id="demo-form" action="${FORM_PATH}" method="post"><DemoText id="demo-form-title">Rails Frame form</DemoText><DemoFormInput id="demo-form-first-name" label="First name" name="profile[first_name]" value="${firstName}" />${error ? `<DemoText id="demo-form-error">${error}</DemoText>` : ""}<DemoFormSubmitter id="demo-form-submit" label="Save first name" name="commit" value="save" /></DemoForm></turbo-frame>`;
}

function takePending(pending: PendingFetch[], message: string): PendingFetch {
  const next = pending.shift();
  if (!next) throw new Error(message);
  return next;
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("renders the bounded Rails Frame form panel through validation and canonical recovery", async () => {
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
  const submitter = () => {
    if (!latestPressable?.onPress) throw new Error("The Rails form submitter did not render");
    return latestPressable;
  };

  try {
    latestPressable = undefined;
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
    expect(renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.value).toBe("");

    await act(async () => {
      renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.onChangeText("invalid");
      await Promise.resolve();
    });
    act(() => {
      submitter().onPress?.();
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

    await act(async () => {
      renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.onChangeText("Ada");
      await Promise.resolve();
    });
    act(() => {
      submitter().onPress?.();
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
    proof.dispose();
    latestPressable = undefined;
  }
});
