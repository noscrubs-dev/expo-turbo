import { describe, expect, test } from "bun:test";
import { StateError } from "expo-turbo/core";

import {
  decodeDemoRouterDocumentPath,
  encodeDemoRouterDocumentPath,
} from "./demo-router-path";

describe("demo Expo Router document path", () => {
  test("encodes canonical document URLs below the demo root as frozen catch-all segments", () => {
    const gallery = encodeDemoRouterDocumentPath("https://example.test/demo");
    const linked = encodeDemoRouterDocumentPath("https://example.test/demo/linked");
    const nested = encodeDemoRouterDocumentPath(
      "https://example.test/demo/routes/ios%20proof/details",
    );

    expect(gallery).toEqual(["demo"]);
    expect(linked).toEqual(["demo", "linked"]);
    expect(nested).toEqual(["demo", "routes", "ios proof", "details"]);
    expect(Object.isFrozen(gallery)).toBe(true);
    expect(Object.isFrozen(linked)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
  });

  test("maps canonical query-bearing document URLs to their generic Router paths", () => {
    expect(
      encodeDemoRouterDocumentPath(
        "https://example.test/demo/routes/ios-proof?tag=a&tag=b&z=",
      ),
    ).toEqual(["demo", "routes", "ios-proof"]);
    expect(
      encodeDemoRouterDocumentPath("https://example.test/demo?flag&space=+&encoded=%20"),
    ).toEqual(["demo"]);
  });

  test("decodes generic catch-all segments to canonical frozen paths", () => {
    const gallery = decodeDemoRouterDocumentPath(["demo"]);
    const linked = decodeDemoRouterDocumentPath(["demo", "linked"]);
    const nested = decodeDemoRouterDocumentPath(["demo", "routes", "ios proof", "details"]);

    expect(gallery).toEqual({
      segments: ["demo"],
      url: "https://example.test/demo",
    });
    expect(linked).toEqual({
      segments: ["demo", "linked"],
      url: "https://example.test/demo/linked",
    });
    expect(nested).toEqual({
      segments: ["demo", "routes", "ios proof", "details"],
      url: "https://example.test/demo/routes/ios%20proof/details",
    });
    expect(Object.isFrozen(gallery)).toBe(true);
    expect(Object.isFrozen(linked)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
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
      "https://example.test/demo#",
      "https://example.test/demo#linked",
      "https://EXAMPLE.test:443/demo",
      "https://example.test/demo/../demo",
      "https://example.test/%64emo",
      "https://example.test/demo%2Flinked",
      "https://example.test/demo%5Clinked",
      "https://example.test/demo\\linked",
      "https://example.test/demo/",
      "https://example.test/demo//nested",
      "https://example.test/demo/%2E",
      "https://example.test/demo/%2E%2E",
      "https://example.test/demo/%2F",
      "https://example.test/demo/%5C",
      "https://example.test/demo/%20",
      "https://example.test/demo/%E0%A4%A",
      "https://example.test/",
      "https://example.test/other",
      "https://example.test/demo/one/two/three/four/five/six/seven/eight",
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
      ["demo", "."],
      ["demo", ".."],
      ["demo", ""],
      ["demo", "nested/segment"],
      ["demo", "nested\\segment"],
      ["demo", "one", "two", "three", "four", "five", "six", "seven", "eight"],
    ]) {
      expect(() => decodeDemoRouterDocumentPath(value)).toThrow(StateError);
    }
  });
});
