const MAX_PICKED_TEXT_UPLOAD_BYTES = 64 * 1024;
const TEXT_PLAIN_MEDIA_TYPE = "text/plain";

export interface DemoPickedTextUpload {
  readonly attachment: Readonly<{
    readonly blob: Blob;
    readonly filename: string;
  }>;
  readonly byteLength: number;
}

function isSafeFilename(value: string): boolean {
  if (value.trim().length === 0 || value.length !== value.trim().length || value.length > 255) return false;
  if (new TextEncoder().encode(value).byteLength > 255) return false;
  return !/[\\/\u0000-\u001f\u007f]/.test(value);
}

function isTextPlain(value: string | undefined, filename: string): boolean {
  if (value === undefined) return filename.toLowerCase().endsWith(".txt");
  const normalized = value?.trim().toLowerCase();
  return normalized === TEXT_PLAIN_MEDIA_TYPE || normalized === "text/plain;charset=utf-8" || normalized === "text/plain; charset=utf-8";
}

function pickerError(message: string): Error {
  return new Error(`Demo text upload ${message}`);
}

/**
 * Converts one Expo DocumentPicker result into the public core's host-owned
 * Blob/file entry shape. The standalone Rails host intentionally accepts only
 * this bounded text profile and discards the uploaded bytes.
 */
export async function pickDemoTextUpload(): Promise<DemoPickedTextUpload | undefined> {
  const [DocumentPicker, FileSystem] = await Promise.all([
    import("expo-document-picker"),
    import("expo-file-system"),
  ]);
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
    type: TEXT_PLAIN_MEDIA_TYPE,
  });
  if (result.canceled) return undefined;
  if (result.assets.length !== 1) throw pickerError("must select exactly one file");

  const [asset] = result.assets;
  if (!asset || !isSafeFilename(asset.name)) throw pickerError("filename is invalid");
  if (!isTextPlain(asset.mimeType, asset.name)) throw pickerError("must be text/plain");

  const file = asset.file ?? new FileSystem.File(asset.uri);
  const byteLength = file.size;
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > MAX_PICKED_TEXT_UPLOAD_BYTES) {
    throw pickerError(`must be between 1 and ${MAX_PICKED_TEXT_UPLOAD_BYTES} bytes`);
  }
  if (asset.size !== undefined && asset.size !== byteLength) throw pickerError("size changed before upload");

  // Expo File satisfies the Web Blob contract, while the React Native Blob type
  // used by the transport has additional platform methods. Copying this small,
  // bounded file yields that exact transport type without retaining a URI.
  const blob = new Blob([await file.arrayBuffer()], { type: TEXT_PLAIN_MEDIA_TYPE });
  return Object.freeze({
    attachment: Object.freeze({ blob, filename: asset.name }),
    byteLength,
  });
}
