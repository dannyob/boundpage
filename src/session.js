import { b64url } from "./util.js";

// Compact HMAC-signed tokens: base64url(json) "." base64url(hmac).
// Used for the session cookie and the OAuth state cookie.

export async function sign(payload, secret, ttlSeconds) {
  const body = b64url(new TextEncoder().encode(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  return body + "." + b64url(new Uint8Array(mac));
}

export async function verify(token, secret) {
  if (typeof token !== "string") return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64url(mac), new TextEncoder().encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function unb64url(text) {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
