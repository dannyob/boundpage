import { env } from "cloudflare:test";
import { handle } from "../src/app.js";

export const ORIGIN = "https://pages.test";
export const ADMIN = { authorization: "Bearer test-admin-token", "content-type": "application/json" };

// GitHub users
export const ALICE = { id: 1, login: "alice", emails: [{ email: "alice@example.com", verified: true, primary: true }] };
export const BOB = { id: 2, login: "bob", emails: [{ email: "bob@example.com", verified: true, primary: true }] };

// Google users: the claims Google would put in the ID token
export const G_ALICE = { google: { sub: "g-111", email: "alice@example.com", email_verified: true } };
export const G_BOB = { google: { sub: "g-222", email: "bob@example.com", email_verified: true } };

// Messages handed to sendMail, newest last.
export const outbox = [];

function unsignedJwt(claims) {
  const enc = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.not-checked`;
}

// Stands in for GitHub and Google; `user` is who "logs in".
function fakeUpstream(user = ALICE) {
  return async (input, init) => {
    const req = new Request(input, init);
    switch (req.url) {
      case "https://github.com/login/oauth/access_token": {
        const body = await req.formData();
        if (body.get("code") !== "good-code" || body.get("client_secret") !== "test-client-secret") {
          return Response.json({ error: "bad_verification_code" });
        }
        return Response.json({ access_token: "gh-token" });
      }
      case "https://api.github.com/user":
        return Response.json({ id: user.id, login: user.login });
      case "https://api.github.com/user/emails":
        return Response.json(user.emails);
      case "https://oauth2.googleapis.com/token": {
        const body = await req.formData();
        if (body.get("code") !== "good-code" || body.get("client_secret") !== "test-google-secret") {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const claims = {
          iss: "https://accounts.google.com",
          aud: "test-google-id",
          exp: Math.floor(Date.now() / 1000) + 3600,
          ...user.google,
        };
        return Response.json({ access_token: "g-token", id_token: unsignedJwt(claims) });
      }
      default:
        return new Response("unexpected request " + req.url, { status: 500 });
    }
  };
}

export function call(path, init = {}, user = ALICE) {
  return handle(new Request(ORIGIN + path, { redirect: "manual", ...init }), env, {
    fetch: fakeUpstream(user),
    sendMail: async (msg) => {
      outbox.push(msg);
    },
  });
}

export function cookieValue(res, name) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const [k, v] = pair.split("=");
    if (k === name) return v;
  }
  return undefined;
}

export async function share({ content = "<p>the secret page</p>", contentType = "text/html", expectEmail } = {}) {
  const res = await call("/admin/resources", {
    method: "POST", headers: ADMIN, body: JSON.stringify({ title: "Shared", contentType, content }),
  });
  const { id } = await res.json();
  const inv = await call(`/admin/resources/${id}/invites`, {
    method: "POST", headers: ADMIN, body: JSON.stringify({ expectEmail }),
  });
  const { url } = await inv.json();
  return { id, url, cap: new URL(url).hash.replace("#cap=", "") };
}

// Runs a provider's OAuth round trip and returns the session cookie value.
export async function login(user, { provider = "github", returnTo = "/" } = {}) {
  const start = await call(`/auth/${provider}/start?return=${encodeURIComponent(returnTo)}`, {}, user);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cb = await call(`/auth/${provider}/callback?code=good-code&state=${state}`, {
    headers: { cookie: `bp_oauth=${cookieValue(start, "bp_oauth")}` },
  }, user);
  return cookieValue(cb, "bp_session");
}

export function open(id, cap, session, user) {
  const headers = { "content-type": "application/json" };
  if (session) headers.cookie = `bp_session=${session}`;
  return call(`/r/${id}/open`, { method: "POST", headers, body: JSON.stringify({ cap }) }, user);
}
