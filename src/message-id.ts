const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;

type JsonReviverContext = { source?: string };
type JsonParseWithContext = (
  text: string,
  reviver: (key: string, value: unknown, context: JsonReviverContext) => unknown,
) => unknown;

/** Normalize a protocol message id without passing it through IEEE-754. */
export function normalizeFmsgMessageId(value: unknown, label = "message id"): string {
  let raw: string;
  if (typeof value === "string") {
    raw = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    raw = String(value);
  } else {
    throw new Error(`fmsg returned an invalid ${label}`);
  }

  if (!/^[0-9]+$/u.test(raw)) throw new Error(`fmsg returned an invalid ${label}`);
  const parsed = BigInt(raw);
  if (parsed < 1n || parsed > MAX_SIGNED_INT64) {
    throw new Error(`fmsg returned an out-of-range ${label}`);
  }
  return parsed.toString();
}

export function compareFmsgMessageIds(left: string, right: string): number {
  try {
    const leftId = BigInt(normalizeFmsgMessageId(left));
    const rightId = BigInt(normalizeFmsgMessageId(right));
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

/**
 * Parse fmsg JSON while retaining exact numeric id/pid tokens as strings.
 * Supported Node releases provide the reviver context's original source text.
 */
export function parseFmsgJson<T = unknown>(text: string): T {
  const parse = JSON.parse as JsonParseWithContext;
  return parse(text, (key, value, context) => {
    if ((key === "id" || key === "pid") && typeof value === "number") {
      const source = context?.source;
      if (source && /^[0-9]+$/u.test(source)) return normalizeFmsgMessageId(source, key);
      return normalizeFmsgMessageId(value, key);
    }
    return value;
  }) as T;
}

/** Append one exact int64 JSON field to an already serializable object. */
export function stringifyWithFmsgInt64(
  value: Record<string, unknown>,
  field: "pid",
  id: string,
): string {
  if (Object.hasOwn(value, field)) throw new Error(`fmsg JSON already contains ${field}`);
  const normalized = normalizeFmsgMessageId(id, field);
  const json = JSON.stringify(value);
  return `${json.slice(0, -1)},${JSON.stringify(field)}:${normalized}}`;
}
