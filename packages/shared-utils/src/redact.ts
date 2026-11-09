export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /pass(word|code)?|secret|token|authorization|cookie|otp|mfa|apikey|api_key|emiratesid|passport|nationalid|iban|cardnumber|cvv/i;

/** Deep-copies a value, replacing anything held under a sensitive key. Safe on cyclic input. */
export function redactSensitive<T>(value: T): T {
  return walk(value, new WeakSet()) as T;
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, seen));
  // Non-plain objects (ObjectId, Decimal128) are leaf values, not nested records.
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : walk(nested, seen),
    ]),
  );
}
