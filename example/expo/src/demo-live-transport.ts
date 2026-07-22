import {
  isTurboMultipartBody,
  type FetchAdapter,
  type TurboRequest,
  type TurboResponse,
} from "expo-turbo/adapters";
import { StateError } from "expo-turbo/core";

export interface DemoLiveFetchRequest {
  readonly body?: string | Uint8Array | FormData;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly signal?: AbortSignal;
}

export interface DemoLiveFetchResponse {
  readonly headers: Readonly<{
    forEach(callback: (value: string, name: string) => void): void;
  }>;
  readonly redirected: boolean;
  readonly status: number;
  readonly url: string;
  text(): Promise<string>;
}

export type DemoLiveFetch = (
  url: string,
  request: DemoLiveFetchRequest,
) => Promise<DemoLiveFetchResponse>;

function requestBody(request: TurboRequest): string | Uint8Array | FormData | undefined {
  const body = request.body;
  if (!body) return undefined;
  if (!isTurboMultipartBody(body.value)) return body.value;
  const formData = new FormData();
  for (const entry of body.value.entries) {
    if (typeof entry.value === "string") {
      formData.append(entry.name, entry.value);
    } else {
      formData.append(entry.name, entry.value.blob, entry.value.filename);
    }
  }
  return formData;
}

export function createDemoLiveFetchAdapter(fetch: DemoLiveFetch): FetchAdapter {
  return Object.freeze({
    async fetch(request: TurboRequest): Promise<TurboResponse> {
      const body = requestBody(request);
      const response = await fetch(request.url, {
        ...(body !== undefined ? { body } : {}),
        headers: {
          ...request.headers,
          ...(request.body && !isTurboMultipartBody(request.body.value)
            ? { "Content-Type": request.body.contentType }
            : {}),
        },
        method: request.method,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      return Object.freeze({
        headers: Object.freeze(headers),
        redirected: response.redirected,
        status: response.status,
        text: () => response.text(),
        url: response.url,
      });
    },
  });
}

export function nativeDemoLiveFetch(
  url: string,
  request: DemoLiveFetchRequest,
): Promise<DemoLiveFetchResponse> {
  if (typeof globalThis.fetch !== "function") {
    return Promise.reject(new StateError("The native Fetch API is unavailable"));
  }
  return globalThis.fetch(url, request as RequestInit);
}
