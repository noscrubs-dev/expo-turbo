import type { FormConfirmationAdapter } from "expo-turbo/adapters";

export interface DemoAlertButton {
  readonly onPress: () => void;
  readonly style?: "cancel";
  readonly text: string;
}

export interface DemoAlertOptions {
  readonly cancelable: true;
  readonly onDismiss: () => void;
}

export interface DemoFormConfirmationOptions {
  readonly platform: string;
  readonly showAlert: (
    title: string,
    message: string,
    buttons: readonly DemoAlertButton[],
    options: DemoAlertOptions,
  ) => void;
  readonly webConfirm: (message: string) => boolean;
}

export function createDemoFormConfirmationAdapter(
  options: DemoFormConfirmationOptions,
): FormConfirmationAdapter {
  return {
    confirm(message, signal) {
      if (signal.aborted) return false;
      if (options.platform === "web") return options.webConfirm(message);

      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (accepted: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", cancel);
          resolve(accepted);
        };
        const cancel = () => finish(false);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) {
          cancel();
          return;
        }
        options.showAlert(
          "Confirm form submission",
          message,
          [
            { onPress: cancel, style: "cancel", text: "Cancel" },
            { onPress: () => finish(true), text: "Continue" },
          ],
          { cancelable: true, onDismiss: cancel },
        );
      });
    },
  };
}
