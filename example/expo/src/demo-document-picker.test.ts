/// <reference types="bun" />

import { beforeEach, expect, mock, test } from "bun:test";

interface PickerAsset {
  readonly file?: Blob;
  readonly lastModified: number;
  readonly mimeType?: string;
  readonly name: string;
  readonly size?: number;
  readonly uri: string;
}

let fileContents = "picked from Files\n";
let fileType = "text/plain";
let nextResult: Readonly<{ readonly assets: readonly PickerAsset[]; readonly canceled: boolean }>;
const pickerCalls: unknown[] = [];

class ExpoFile extends Blob {
  constructor(readonly uri: string) {
    super([fileContents], { type: fileType });
  }
}

mock.module("expo-document-picker", () => ({
  getDocumentAsync: async (options: unknown) => {
    pickerCalls.push(options);
    return nextResult;
  },
}));

mock.module("expo-file-system", () => ({ File: ExpoFile }));

const { pickDemoTextUpload } = await import("./demo-document-picker");

beforeEach(() => {
  fileContents = "picked from Files\n";
  fileType = "text/plain";
  pickerCalls.splice(0);
  nextResult = Object.freeze({
    assets: Object.freeze([
      Object.freeze({
        lastModified: 0,
        mimeType: "text/plain",
        name: "picked-notes.txt",
        size: fileContents.length,
        uri: "file:///cache/picked-notes.txt",
      }),
    ]),
    canceled: false,
  });
});

test("turns one cached native text file into a bounded multipart Blob entry", async () => {
  const picked = await pickDemoTextUpload();
  if (!picked) throw new Error("The picker unexpectedly canceled");

  expect(picked).toMatchObject({
    attachment: { filename: "picked-notes.txt" },
    byteLength: fileContents.length,
  });
  expect(await picked.attachment.blob.text()).toBe(fileContents);
  expect(picked.attachment.blob.type).toMatch(/^text\/plain(?:;charset=utf-8)?$/);
  expect(pickerCalls).toEqual([{ copyToCacheDirectory: true, multiple: false, type: "text/plain" }]);
});

test("keeps the current attachment when the system picker is canceled", async () => {
  nextResult = Object.freeze({ assets: Object.freeze([]), canceled: true });

  await expect(pickDemoTextUpload()).resolves.toBeUndefined();
});

test("admits a .txt asset when an iOS provider omits its optional media type", async () => {
  nextResult = Object.freeze({
    assets: Object.freeze([
      Object.freeze({
        lastModified: 0,
        name: "provider-without-mime.txt",
        size: fileContents.length,
        uri: "file:///cache/provider-without-mime.txt",
      }),
    ]),
    canceled: false,
  });

  await expect(pickDemoTextUpload()).resolves.toMatchObject({
    attachment: { filename: "provider-without-mime.txt" },
  });
});

test("fails closed for a bad media type, unsafe filename, or oversized file", async () => {
  nextResult = Object.freeze({
    assets: Object.freeze([
      Object.freeze({
        lastModified: 0,
        mimeType: "application/pdf",
        name: "picked-notes.txt",
        size: fileContents.length,
        uri: "file:///cache/picked-notes.txt",
      }),
    ]),
    canceled: false,
  });
  await expect(pickDemoTextUpload()).rejects.toThrow("must be text/plain");

  nextResult = Object.freeze({
    assets: Object.freeze([
      Object.freeze({
        lastModified: 0,
        mimeType: "text/plain",
        name: "../picked-notes.txt",
        size: fileContents.length,
        uri: "file:///cache/picked-notes.txt",
      }),
    ]),
    canceled: false,
  });
  await expect(pickDemoTextUpload()).rejects.toThrow("filename is invalid");

  fileContents = "x".repeat(64 * 1024 + 1);
  nextResult = Object.freeze({
    assets: Object.freeze([
      Object.freeze({
        lastModified: 0,
        mimeType: "text/plain",
        name: "picked-notes.txt",
        size: fileContents.length,
        uri: "file:///cache/picked-notes.txt",
      }),
    ]),
    canceled: false,
  });
  await expect(pickDemoTextUpload()).rejects.toThrow("must be between 1 and 65536 bytes");
});
