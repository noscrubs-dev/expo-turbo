import { describe, expect, test } from "bun:test";
import { StateError } from "expo-turbo/core";

import {
  decodeDemoRouterDocumentPath,
  encodeDemoRouterDocumentPath,
} from "./demo-router-path";

describe("demo Expo Router document path", () => {
  test("encodes the supported canonical document URLs as frozen catch-all segments", () => {
    const gallery = encodeDemoRouterDocumentPath("https://example.test/demo");
    const linked = encodeDemoRouterDocumentPath("https://example.test/demo/linked");

    expect(gallery).toEqual(["demo"]);
    expect(linked).toEqual(["demo", "linked"]);
    expect(Object.isFrozen(gallery)).toBe(true);
    expect(Object.isFrozen(linked)).toBe(true);
  });

  test("decodes supported catch-all segments to canonical frozen paths", () => {
    const gallery = decodeDemoRouterDocumentPath(["demo"]);
    const linked = decodeDemoRouterDocumentPath(["demo", "linked"]);

    expect(gallery).toEqual({
      segments: ["demo"],
      url: "https://example.test/demo",
    });
    expect(linked).toEqual({
      segments: ["demo", "linked"],
      url: "https://example.test/demo/linked",
    });
    expect(Object.isFrozen(gallery)).toBe(true);
    expect(Object.isFrozen(linked)).toBe(true);
  });

  test("rejects non-canonical document URLs without exposing their values", () => {
    for (const value of [
      undefined,
      7,
      "__proto__",
      "toString",
      "not-a-url",
      "http://example.test/demo",
      "https://other.test/demo",
      "https://user:secret@example.test/demo",
      "https://example.test/demo?",
      "https://example.test/demo?source=deep-link",
      "https://example.test/demo#",
      "https://example.test/demo#linked",
      "https://EXAMPLE.test:443/demo",
      "https://example.test/demo/../demo",
      "https://example.test/%64emo",
      "https://example.test/demo%2Flinked",
      "https://example.test/demo%5Clinked",
      "https://example.test/demo\\linked",
      "https://example.test/demo/",
      "https://example.test/",
      "https://example.test/demo/other",
    ]) {
      let error: unknown;
      try {
        encodeDemoRouterDocumentPath(value);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(StateError);
      expect(String(error)).not.toContain("secret");
    }
  });

  test("rejects malformed and unsupported catch-all segments", () => {
    for (const value of [
      undefined,
      "demo",
      [],
      [7],
      [""],
      ["demo", ""],
      ["demo/linked"],
      ["demo\\linked"],
      ["demo%2Flinked"],
      ["demo%5Clinked"],
      ["other"],
      ["demo", "other"],
      ["demo", "linked", "extra"],
    ]) {
      expect(() => decodeDemoRouterDocumentPath(value)).toThrow(StateError);
    }
  });
});
