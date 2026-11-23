/** Accept only absolute HTTPS links without credentials or ambiguous URL syntax. */
export function safePaymentUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https:\/\/[^/]/i.test(value) || /[\s\\\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
