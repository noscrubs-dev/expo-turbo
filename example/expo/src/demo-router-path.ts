import { StateError } from "expo-turbo/core";

export const DEMO_ROUTER_PATH_PARAM = "expoTurboPath";

interface DemoRouterDocumentPath {
  readonly segments: readonly string[];
  readonly url: string;
}

const encodedSeparator = /%(?:2f|5c)/i;

const paths = Object.freeze({
  "/demo": Object.freeze({
    segments: Object.freeze(["demo"]),
    url: "https://example.test/demo",
  }),
  "/demo/linked": Object.freeze({
    segments: Object.freeze(["demo", "linked"]),
    url: "https://example.test/demo/linked",
  }),
} satisfies Record<string, DemoRouterDocumentPath>);

function documentPath(pathname: string): DemoRouterDocumentPath {
  const path = Object.hasOwn(paths, pathname)
    ? paths[pathname as keyof typeof paths]
    : undefined;
  if (!path) throw new StateError("The Expo Turbo demo Router path is unsupported");
  return path;
}

export function encodeDemoRouterDocumentPath(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    throw new StateError("The Expo Turbo demo document URL is invalid");
  }
  if (value === "https://example.test/demo") return paths["/demo"].segments;
  if (value === "https://example.test/demo/linked") {
    return paths["/demo/linked"].segments;
  }
  throw new StateError("The Expo Turbo demo document URL is invalid");
}

export function decodeDemoRouterDocumentPath(value: unknown): DemoRouterDocumentPath {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (segment) =>
        typeof segment !== "string" ||
        segment === "" ||
        segment.includes("/") ||
        segment.includes("\\") ||
        encodedSeparator.test(segment),
    )
  ) {
    throw new StateError("The Expo Turbo demo Router path is invalid");
  }
  return documentPath(`/${value.join("/")}`);
}
