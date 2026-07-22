import { StateError } from "expo-turbo/core";

export const DEMO_ROUTER_PATH_PARAM = "expoTurboPath";

interface DemoRouterDocumentPath {
  readonly segments: readonly string[];
  readonly url: string;
}

const encodedSeparator = /%(?:2f|5c)/i;
const demoOrigin = "https://example.test";
const maxSegmentCount = 8;
const maxSegmentLength = 96;

function pathError(): never {
  throw new StateError("The Expo Turbo demo Router path is invalid");
}

function hasUnsafeSegmentCharacter(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}

function assertSegment(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() === "" ||
    value.length > maxSegmentLength ||
    value === "." ||
    value === ".." ||
    hasUnsafeSegmentCharacter(value) ||
    encodedSeparator.test(value)
  ) {
    return pathError();
  }
  return value;
}

function documentPath(segments: readonly string[]): DemoRouterDocumentPath {
  if (
    segments.length === 0 ||
    segments.length > maxSegmentCount ||
    segments[0] !== "demo"
  ) {
    return pathError();
  }
  const safeSegments = Object.freeze(segments.map(assertSegment));
  const url = new URL(`/${safeSegments.map(encodeURIComponent).join("/")}`, demoOrigin);
  return Object.freeze({ segments: safeSegments, url: url.toString() });
}

function documentPathFromUrl(pathname: string): DemoRouterDocumentPath {
  if (!pathname.startsWith("/") || pathname.endsWith("/")) return pathError();
  const rawSegments = pathname.slice(1).split("/");
  if (rawSegments.some((segment) => segment === "" || encodedSeparator.test(segment))) {
    return pathError();
  }
  const segments = rawSegments.map((segment) => {
    try {
      return assertSegment(decodeURIComponent(segment));
    } catch {
      return pathError();
    }
  });
  const path = documentPath(segments);
  if (new URL(path.url).pathname !== pathname) return pathError();
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
    path: documentPathFromUrl(url.pathname),
    url: url.href,
  });
}

export function encodeDemoRouterDocumentPath(value: unknown): readonly string[] {
  return canonicalDocumentUrl(value).path.segments;
}

export function decodeDemoRouterDocumentPath(value: unknown): DemoRouterDocumentPath {
  if (!Array.isArray(value)) return pathError();
  return documentPath(value);
}
