/**
 * ArrayBuffer → base64, for writing binary files (audio, thumbnails) through
 * Capacitor Filesystem, whose binary `writeFile` takes base64.
 *
 * Kept in its own Capacitor-free module so it is unit-testable in Node without
 * importing the Filesystem plugin. Chunked because spreading a multi-megabyte
 * audio buffer into `String.fromCharCode(...)` in one call overflows the stack.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → ArrayBuffer, for decoding a downloaded audio file read off the Filesystem. */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
