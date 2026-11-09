/**
 * auth.js — the single instructor PIN (Cloudflare secret ADMIN_PIN; never in the repo).
 * Set it with:  npx wrangler secret put ADMIN_PIN
 * For local `wrangler dev`, put ADMIN_PIN=... in cloud/.dev.vars (gitignored).
 */

export const MIN_PIN_LENGTH = 6;

/** Constant-time comparison so response timing doesn't leak how much of a guess was right. */
export function pinMatches(given, expected) {
    if (typeof expected !== "string" || expected.length < MIN_PIN_LENGTH) return false; // not configured
    if (typeof given !== "string") return false;
    const a = new TextEncoder().encode(given);
    const b = new TextEncoder().encode(expected);
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        diff |= (a[i] || 0) ^ (b[i] || 0);
    }
    return diff === 0;
}

/** PIN from an `Authorization: Bearer <pin>` header. */
export function pinFromRequest(request) {
    const h = request.headers.get("Authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1] : null;
}
