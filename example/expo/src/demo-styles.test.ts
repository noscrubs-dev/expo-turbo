import { describe, expect, test } from "bun:test";
import { resolveComponentStyle } from "expo-turbo/adapters";
import { PropsError } from "expo-turbo/core";

import {
  createDemoStyleAdapter,
  DEMO_CARD_BASE_STYLE,
  type DemoStyle,
} from "./demo-styles";

describe("example semantic styles", () => {
  test("resolves fixed tone, spacing, layout, safe-area, and platform styles", () => {
    const adapter = createDemoStyleAdapter({ platform: "android", safeAreaTop: 24 });
    const styles = resolveComponentStyle<DemoStyle, string>(
      adapter,
      {
        component: DEMO_CARD_BASE_STYLE,
        props: { backgroundColor: "#123456" },
        tokens: [
          "tone:info",
          "space:comfortable",
          "layout:row",
          "safe-area:top",
          "surface:elevated",
        ],
      },
      { component: "DemoCard" },
    );

    expect(styles).toMatchObject({
      backgroundColor: "#123456",
      elevation: 4,
      flexDirection: "row",
      gap: 8,
      padding: 16,
      paddingTop: 24,
    });
    expect(Object.isFrozen(styles)).toBe(true);
    expect(adapter.tokens).toEqual([...adapter.tokens].sort());
  });

  test("fails closed for conflicting, inapplicable, and unsupported variants", () => {
    const adapter = createDemoStyleAdapter({ platform: "ios", safeAreaTop: 0 });
    expect(() =>
      adapter.resolve(["tone:info", "tone:warning"], { component: "DemoCard" }),
    ).toThrow(PropsError);
    expect(() => adapter.resolve(["layout:row"], { component: "DemoText" })).toThrow(
      PropsError,
    );
    expect(() =>
      createDemoStyleAdapter({
        platform: "windows" as "ios",
        safeAreaTop: 0,
      }),
    ).toThrow(/unsupported/);
  });

  test("uses host platform variants for one semantic elevation token", () => {
    const android = createDemoStyleAdapter({ platform: "android", safeAreaTop: 0 }).resolve(
      ["surface:elevated"],
      { component: "DemoCard" },
    );
    const ios = createDemoStyleAdapter({ platform: "ios", safeAreaTop: 0 }).resolve(
      ["surface:elevated"],
      { component: "DemoCard" },
    );

    expect(android).toMatchObject({ elevation: 4 });
    expect(ios).toMatchObject({ shadowOpacity: 0.18 });
  });
});
