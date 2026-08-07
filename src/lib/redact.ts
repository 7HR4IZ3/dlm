const SECRET_PATTERNS = [/authorization/i, /token/i, /cookie/i, /secret/i];

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SECRET_PATTERNS.some((pattern) => pattern.test(key)) ? "[redacted]" : value,
    ]),
  );
}
