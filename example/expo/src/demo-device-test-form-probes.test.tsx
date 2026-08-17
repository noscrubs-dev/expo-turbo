import { describe, expect, mock, test } from "bun:test";
import type { ActiveFormSubmissionReport } from "expo-turbo/core";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true;

const nativeComponent = (props: Readonly<Record<string, unknown>>) =>
  createElement("native-component", props);

mock.module("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Alert: { alert: () => undefined },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  FlatList: nativeComponent,
  InteractionManager: {
    runAfterInteractions(callback: () => void) {
      callback();
      return { cancel: () => undefined };
    },
  },
  Keyboard: { addListener: () => ({ remove: () => undefined }), dismiss: () => undefined },
  Linking: { openURL: async () => undefined },
  Platform: { OS: "web" },
  Pressable: nativeComponent,
  ScrollView: nativeComponent,
  Switch: nativeComponent,
  Text: (props: Readonly<Record<string, unknown>>) => createElement("native-text", props),
  TextInput: (props: Readonly<Record<string, unknown>>) => createElement("text-input", props),
  useWindowDimensions: () => ({ height: 844, width: 390 }),
  View: nativeComponent,
}));

const { useDemoDeviceTestFocusProbe, useDemoDeviceTestSubmitProof } = await import(
  "./demo-device-test-form-probes"
);

function FocusHarness({ enabled }: Readonly<{ enabled: boolean }>) {
  const proof = useDemoDeviceTestFocusProbe(enabled, "focus-proof");
  return createElement(
    "focus-harness",
    null,
    createElement("text-input", {
      onBlur: proof.onActualBlur,
      onFocus: proof.onActualFocus,
    }),
    proof.probe,
  );
}

function DeviceTestOffHarness() {
  const focus = useDemoDeviceTestFocusProbe(false, "focus-proof");
  const submit = useDemoDeviceTestSubmitProof(false, "submit-proof");
  return createElement(
    "production-harness",
    null,
    createElement("text-input", {
      onBlur: focus.onActualBlur,
      onFocus: focus.onActualFocus,
    }),
    focus.probe,
    submit.probe,
  );
}

describe("device form probes", () => {
  test("records only actual React Native focus and blur events with increasing revisions", () => {
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(FocusHarness, { enabled: true }));
    });
    if (!renderer) throw new Error("focus harness did not render");
    const rendered = renderer;
    const input = rendered.root.find((node) => String(node.type) === "text-input");
    const proof = () => rendered.root.findByProps({ testID: "focus-proof" });

    expect(proof().props.children).toEqual([
      "Focus probe: ",
      "unobserved",
      "; revision ",
      0,
    ]);
    act(() => input.props.onFocus());
    expect(proof().props.children).toEqual([
      "Focus probe: ",
      "focused",
      "; revision ",
      1,
    ]);
    act(() => input.props.onBlur());
    expect(proof().props.children).toEqual([
      "Focus probe: ",
      "blurred",
      "; revision ",
      2,
    ]);
    act(() => input.props.onFocus());
    expect(proof().props.children).toEqual([
      "Focus probe: ",
      "focused",
      "; revision ",
      3,
    ]);
    act(() => rendered.unmount());
  });

  test("does not render focus or submit probes when device-test mode is off", () => {
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(DeviceTestOffHarness));
    });
    if (!renderer) throw new Error("production harness did not render");
    const rendered = renderer;

    expect(rendered.root.findAllByProps({ testID: "focus-proof" })).toHaveLength(0);
    expect(rendered.root.findAllByProps({ testID: "submit-proof" })).toHaveLength(0);
    act(() => rendered.root.find((node) => String(node.type) === "text-input").props.onFocus());
    expect(rendered.root.findAllByProps({ testID: "focus-proof" })).toHaveLength(0);
    act(() => rendered.unmount());
  });

  test("increments submit proof only when an actual submission runs and records invalid", async () => {
    const submission = mock(() =>
      Promise.resolve({
        firstInvalid: { message: "First name is required", nodeKey: "id:first-name" },
        invalidControls: [
          { message: "First name is required", nodeKey: "id:first-name" },
        ],
        requestId: "request-invalid",
        status: "invalid" as const,
      }),
    );
    function SubmitHarness() {
      const proof = useDemoDeviceTestSubmitProof(true, "submit-proof");
      return createElement(
        "submit-harness",
        null,
        createElement("submit-button", {
          onPress: (): Promise<ActiveFormSubmissionReport> => proof.observe(submission()),
        }),
        proof.probe,
      );
    }
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(SubmitHarness));
    });
    if (!renderer) throw new Error("submit harness did not render");
    const rendered = renderer;
    const proof = () => rendered.root.findByProps({ testID: "submit-proof" });
    const submit = rendered.root.find((node) => String(node.type) === "submit-button");

    expect(submission).toHaveBeenCalledTimes(0);
    expect(proof().props.children).toEqual([
      "Submit proof: ",
      "unobserved",
      "; attempt ",
      0,
    ]);
    await act(async () => {
      await submit.props.onPress();
    });
    expect(submission).toHaveBeenCalledTimes(1);
    expect(proof().props.children).toEqual([
      "Submit proof: ",
      "invalid",
      "; attempt ",
      1,
    ]);
    await act(async () => {
      await submit.props.onPress();
    });
    expect(proof().props.children).toEqual([
      "Submit proof: ",
      "invalid",
      "; attempt ",
      2,
    ]);
    act(() => rendered.unmount());
  });

  test("records the status from a resolved non-invalid submission report", async () => {
    const report = {
      destination: { kind: "document" as const },
      effectiveMethod: "POST" as const,
      requestId: "request-canceled",
      requestedUrl: "https://example.test/demo/profile",
      sourceMethod: "POST" as const,
      status: "canceled" as const,
      transportMethod: "POST" as const,
    } satisfies ActiveFormSubmissionReport;
    function SubmitHarness() {
      const proof = useDemoDeviceTestSubmitProof(true, "submit-proof");
      return createElement(
        "submit-harness",
        null,
        createElement("submit-button", {
          onPress: (): Promise<ActiveFormSubmissionReport> => proof.observe(Promise.resolve(report)),
        }),
        proof.probe,
      );
    }
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(SubmitHarness));
    });
    if (!renderer) throw new Error("submit harness did not render");
    const rendered = renderer;

    await act(async () => {
      await rendered.root.find((node) => String(node.type) === "submit-button").props.onPress();
    });
    expect(rendered.root.findByProps({ testID: "submit-proof" }).props.children).toEqual([
      "Submit proof: ",
      "canceled",
      "; attempt ",
      1,
    ]);
    act(() => rendered.unmount());
  });
});
