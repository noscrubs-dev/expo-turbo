import type { FetchAdapter, TurboRequest, TurboResponse } from "expo-turbo/adapters";
import { StateError } from "expo-turbo/core";

export interface DemoLiveFetchRequest {
  readonly body?: string | Uint8Array;
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

export function createDemoLiveFetchAdapter(fetch: DemoLiveFetch): FetchAdapter {
  return Object.freeze({
    async fetch(request: TurboRequest): Promise<TurboResponse> {
      const response = await fetch(request.url, {
        ...(request.body ? { body: request.body.value } : {}),
        headers: {
          ...request.headers,
          ...(request.body ? { "Content-Type": request.body.contentType } : {}),
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
