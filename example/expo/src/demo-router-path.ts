import { StateError } from "expo-turbo/core";

export const DEMO_ROUTER_PATH_PARAM = "expoTurboPath";

interface DemoRouterDocumentPath {
  readonly segments: readonly string[];
  readonly url: string;
}

const encodedSeparator = /%(?:2f|5c)/i;
const demoOrigin = "https://example.test";

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

function canonicalDocumentUrl(value: unknown): Readonly<{
  path: DemoRouterDocumentPath;
  url: string;
}> {
  if (typeof value !== "string") {
    throw new StateError("The Expo Turbo demo document URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StateError("The Expo Turbo demo document URL is invalid");
  }
  if (
    url.href !== value ||
    url.origin !== demoOrigin ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    value.includes("#") ||
    (url.search === "" && value.includes("?"))
  ) {
    throw new StateError("The Expo Turbo demo document URL is invalid");
  }
  return Object.freeze({
    path: documentPath(url.pathname),
    url: url.href,
  });
}

export function encodeDemoRouterDocumentPath(value: unknown): readonly string[] {
  return canonicalDocumentUrl(value).path.segments;
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
