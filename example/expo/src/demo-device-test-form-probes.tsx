import type { ActiveFormSubmissionReport } from "expo-turbo/core";
import { useCallback, useRef, useState } from "react";
import { Text } from "react-native";

type FocusProbeStatus = "blurred" | "focused" | "unobserved";

export function useDemoDeviceTestFocusProbe(enabled: boolean, testID: string) {
  const [proof, setProof] = useState<
    Readonly<{ revision: number; status: FocusProbeStatus }>
  >({ revision: 0, status: "unobserved" });
  const record = useCallback(
    (status: Exclude<FocusProbeStatus, "unobserved">) => {
      if (!enabled) return;
      setProof((current) => ({ revision: current.revision + 1, status }));
    },
    [enabled],
  );

  return {
    onActualBlur: useCallback(() => record("blurred"), [record]),
    onActualFocus: useCallback(() => record("focused"), [record]),
    probe: enabled ? (
      <Text selectable testID={testID}>
        Focus probe: {proof.status}; revision {proof.revision}
      </Text>
    ) : null,
  } as const;
}

export function useDemoDeviceTestSubmitProof(enabled: boolean, testID: string) {
  const attempt = useRef(0);
  const [proof, setProof] = useState<Readonly<{ attempt: number; status: string }>>({
    attempt: 0,
    status: "unobserved",
  });
  const observe = useCallback(
    async (submission: Promise<ActiveFormSubmissionReport>) => {
      const currentAttempt = ++attempt.current;
      try {
        const report = await submission;
        setProof({ attempt: currentAttempt, status: report.status });
        return report;
      } catch (error) {
        setProof({ attempt: currentAttempt, status: "rejected" });
        throw error;
      }
    },
    [],
  );

  return {
    observe,
    probe: enabled ? (
      <Text selectable testID={testID}>
        Submit proof: {proof.status}; attempt {proof.attempt}
      </Text>
    ) : null,
  } as const;
}
