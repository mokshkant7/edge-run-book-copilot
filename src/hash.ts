/**
 * SHA-256 digest of a UTF-8 string.
 * @param text Input text.
 * @returns Lowercase hex digest (64 characters).
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
