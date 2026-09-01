const API_KEY_PATTERN = /\bfmsgk_[A-Za-z0-9._~-]{6,}\b/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/gu;
export function redactSecrets(text) {
    return text.replace(API_KEY_PATTERN, "[REDACTED_FMSG_API_KEY]").replace(JWT_PATTERN, "[REDACTED_JWT]");
}
export function formatSafeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return redactSecrets(message).replace(/[\r\n\u2028\u2029]+/gu, " ").slice(0, 1000);
}
