/** Normalize a protocol message id without passing it through IEEE-754. */
export declare function normalizeFmsgMessageId(value: unknown, label?: string): string;
export declare function compareFmsgMessageIds(left: string, right: string): number;
/**
 * Parse fmsg JSON while retaining exact numeric id/pid tokens as strings.
 * Supported Node releases provide the reviver context's original source text.
 */
export declare function parseFmsgJson<T = unknown>(text: string): T;
/** Append one exact int64 JSON field to an already serializable object. */
export declare function stringifyWithFmsgInt64(value: Record<string, unknown>, field: "pid", id: string): string;
