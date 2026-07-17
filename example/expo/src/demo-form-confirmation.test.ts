/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import {
  type DemoAlertButton,
  createDemoFormConfirmationAdapter,
} from "./demo-form-confirmation";

describe("demo form confirmation", () => {
  test("settles each native Alert answer", async () => {
    let buttons: readonly DemoAlertButton[] = [];
    let dismiss: () => void = () => undefined;
    const adapter = createDemoFormConfirmationAdapter({
      platform: "ios",
      showAlert(_title, _message, nextButtons, options) {
        buttons = nextButtons;
        dismiss = options.onDismiss;
      },
      webConfirm: () => false,
    });

    const accepted = adapter.confirm("Accept?", new AbortController().signal);
    buttons.find((button) => button.text === "Continue")?.onPress();
    expect(await accepted).toBe(true);

    const canceled = adapter.confirm("Cancel?", new AbortController().signal);
    buttons.find((button) => button.text === "Cancel")?.onPress();
    expect(await canceled).toBe(false);

    const dismissed = adapter.confirm("Dismiss?", new AbortController().signal);
    dismiss();
    expect(await dismissed).toBe(false);
  });

  test("settles the native Alert path on cancellation and ignores a stale answer", async () => {
    let buttons: readonly DemoAlertButton[] = [];
    const adapter = createDemoFormConfirmationAdapter({
      platform: "ios",
      showAlert(_title, _message, nextButtons) {
        buttons = nextButtons;
      },
      webConfirm: () => false,
    });
    const controller = new AbortController();
    const confirming = adapter.confirm("Continue natively?", controller.signal);

    expect(buttons.map((button) => button.text)).toEqual(["Cancel", "Continue"]);
    controller.abort();
    expect(await confirming).toBe(false);
    buttons.find((button) => button.text === "Continue")?.onPress();
    expect(await confirming).toBe(false);
  });

  test("uses a settling browser confirmation instead of react-native-web Alert", async () => {
    const messages: string[] = [];
    const adapter = createDemoFormConfirmationAdapter({
      platform: "web",
      showAlert() {
        throw new Error("react-native-web Alert must not be used");
      },
      webConfirm(message) {
        messages.push(message);
        return true;
      },
    });

    expect(await adapter.confirm("Continue on web?", new AbortController().signal)).toBe(true);
    expect(messages).toEqual(["Continue on web?"]);
  });
});
