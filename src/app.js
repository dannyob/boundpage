import { sign, verify } from "./session.js";
import { provider, configuredProviders } from "./providers.js";
import { BOOTSTRAP_PAGE, CONFIRM_PAGE } from "./page.js";

const SESSION_TTL = 30 * 24 * 3600;
const OAUTH_TTL = 600;

// deps.fetch is the outbound fetch, injected so tests can stand in for GitHub.
export async function handle(request, env, deps) {
  const url = new URL(request.url);
  const path = url.pathname;
  let m;

  if (request.method === "GET" && path === "/") {
    return new Response("boundpage\n", { headers: { "content-type": "text/plain" } });
  }
  if (request.method === "POST" && path === "/admin/resources") {
    return createResource(request, env);
  }
  if (request.method === "POST" && (m = path.match(/^\/admin\/resources\/([^/]+)\/invites$/))) {
    return createInvite(request, env, m[1], url.origin);
  }
  if ((request.method === "GET" || request.method === "HEAD") && /^\/r\/[^/]+$/.test(path)) {
    return page(request, BOOTSTRAP_PAGE);
  }
  if (request.method === "POST" && (m = path.match(/^\/r\/([^/]+)\/open$/))) {
    return openResource(request, env, m[1]);
  }
  if (request.method === "GET" && (m = path.match(/^\/auth\/([a-z]+)\/start$/)) && provider(env, m[1])) {
    return startLogin(env, url, m[1]);
  }
  if (request.method === "GET" && (m = path.match(/^\/auth\/([a-z]+)\/callback$/)) && provider(env, m[1])) {
    return finishLogin(request, env, deps, url, m[1]);
  }
  if (emailEnabled(env)) {
    if (request.method === "POST" && path === "/auth/email/start") {
      return startEmailLogin(request, env, deps, url.origin);
    }
    if (request.method === "POST" && path === "/auth/email/verify") {
      return finishEmailLogin(request, env);
    }
    if ((request.method === "GET" || request.method === "HEAD") && path === "/auth/email/confirm") {
      return page(request, CONFIRM_PAGE);
    }
  }
  if (request.method === "POST" && path === "/auth/logout") {
    return redirect(safeReturn(url.searchParams.get("return")), [cookie("bp_session", "", { maxAge: 0 })]);
  }
  return new Response("Not found", { status: 404 });
}

async function createResource(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  const { title, contentType, content } = await request.json();
  if (!["text/html", "text/markdown"].includes(contentType) || typeof content !== "string") {
    return Response.json({ error: "need contentType text/html or text/markdown, and content" }, { status: 400 });
  }
  const id = env.RESOURCE.newUniqueId();
  await env.RESOURCE.get(id).setContent({ title: title || "Shared page", contentType, content });
  return Response.json({ id: id.toString() }, { status: 201 });
}

async function createInvite(request, env, id, origin) {
  if (!(await isAdmin(request, env))) return unauthorized();
  const stub = resourceStub(env, id);
  if (!stub) return new Response("Not found", { status: 404 });
  const { expectEmail } = await request.json().catch(() => ({}));
  const cap = await stub.mintInvite({ expectEmail });
  return Response.json({ url: `${origin}/r/${id}#cap=${cap}` }, { status: 201 });
}

async function openResource(request, env, id) {
  const stub = resourceStub(env, id);
  if (!stub) return Response.json({ error: "not found" }, { status: 404 });
  const { cap } = await request.json().catch(() => ({}));
  const session = await verify(readCookie(request, "bp_session"), env.SESSION_SECRET);
  const result = await stub.open(cap, session && { sub: session.sub, emails: session.emails });

  switch (result.status) {
    case "ok":
      return Response.json({ title: result.title, html: result.html });
    case "login": {
      const ret = encodeURIComponent(`/r/${id}`);
      const methods = configuredProviders(env).map((p) => ({ ...p, url: `/auth/${p.id}/start?return=${ret}` }));
      return Response.json({ methods, email: emailEnabled(env) }, { status: 401 });
    }
    case "forbidden":
      return Response.json({ signedInAs: session.login }, { status: 403 });
    default:
      return Response.json({ error: "not found" }, { status: 404 });
  }
}

async function startLogin(env, url, id) {
  const nonce = crypto.randomUUID();
  const ret = safeReturn(url.searchParams.get("return"));
  const state = await sign({ nonce, ret }, env.SESSION_SECRET, OAUTH_TTL);
  return redirect(provider(env, id).authorizeUrl(env, `${url.origin}/auth/${id}/callback`, nonce), [
    cookie("bp_oauth", state, { maxAge: OAUTH_TTL, path: `/auth/${id}` }),
  ]);
}

async function finishLogin(request, env, deps, url, id) {
  const pending = await verify(readCookie(request, "bp_oauth"), env.SESSION_SECRET);
  if (!pending || pending.nonce !== url.searchParams.get("state")) {
    return new Response("Login expired or did not match. Try again.", { status: 400 });
  }
  const p = provider(env, id);
  const identity = await p.identityFromCode(env, deps.fetch, url.searchParams.get("code"), `${url.origin}/auth/${id}/callback`);
  if (!identity) return new Response(`${p.name} did not accept the login.`, { status: 400 });
  return startSession(env, identity, pending.ret, [cookie("bp_oauth", "", { maxAge: 0, path: `/auth/${id}` })]);
}

async function startSession(env, identity, ret, extraCookies = []) {
  return redirect(ret, [await sessionCookie(env, identity), ...extraCookies]);
}

async function sessionCookie(env, identity) {
  return cookie("bp_session", await sign(identity, env.SESSION_SECRET, SESSION_TTL), { maxAge: SESSION_TTL });
}

function emailEnabled(env) {
  return Boolean(env.MAIL_FROM && env.SMTP_PASS);
}

function emailLogin(env, address) {
  return env.EMAIL_LOGIN.get(env.EMAIL_LOGIN.idFromName(address));
}

// Sending a code needs a live capability, so the site can only be made to
// mail people who were sent a link.
async function startEmailLogin(request, env, deps, origin) {
  const { resource, cap, email } = await request.json().catch(() => ({}));
  const address = normaliseEmail(email);
  if (!address) return Response.json({ error: "not an email address" }, { status: 400 });
  const stub = resourceStub(env, resource);
  if (!stub || (await stub.open(cap, null)).status !== "login") {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const issued = await emailLogin(env, address).issue();
  if (!issued.ok) return Response.json({ error: "too many codes; try again later" }, { status: 429 });

  const host = new URL(origin).host;
  const link = `${origin}/auth/email/confirm#` + new URLSearchParams({ email: address, code: issued.code, return: `/r/${resource}` });
  await deps.sendMail({
    to: address,
    subject: `Your ${host} code is ${issued.code}`,
    text:
      `Your sign-in code for ${host} is:\n\n    ${issued.code}\n\n` +
      `It works for 10 minutes. You can also open this link and press "Sign in":\n\n${link}\n\n` +
      `If you did not ask for this, you can ignore this email.\n`,
  });
  return Response.json({ sent: true });
}

async function finishEmailLogin(request, env) {
  const { email, code } = await request.json().catch(() => ({}));
  const address = normaliseEmail(email);
  if (!address || !/^\d{6}$/.test(String(code)) || !(await emailLogin(env, address).verify(String(code)))) {
    return Response.json({ error: "wrong or expired code" }, { status: 401 });
  }
  const identity = { sub: `email:${address}`, login: address, emails: [address] };
  return Response.json({ ok: true }, { headers: { "set-cookie": await sessionCookie(env, identity) } });
}

// Lower-cased address, or null. No whitespace or header punctuation, so it
// is safe to put in a mail header.
function normaliseEmail(email) {
  if (typeof email !== "string") return null;
  const address = email.trim().toLowerCase();
  if (address.length > 254) return null;
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z0-9-]{2,}$/.test(address) ? address : null;
}

function page(request, html) {
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
    },
  });
}

function resourceStub(env, id) {
  try {
    return env.RESOURCE.get(env.RESOURCE.idFromString(id));
  } catch {
    return null;
  }
}

async function isAdmin(request, env) {
  const given = request.headers.get("authorization") || "";
  const [a, b] = await Promise.all([digest(given), digest(`Bearer ${env.ADMIN_TOKEN}`)]);
  return Boolean(env.ADMIN_TOKEN) && a === b;
}

async function digest(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].join(",");
}

function unauthorized() {
  return Response.json({ error: "admin token required" }, { status: 401 });
}

// Only same-site absolute paths; anything else (including "//host") goes home.
function safeReturn(ret) {
  return typeof ret === "string" && /^\/(?![/\\])/.test(ret) ? ret : "/";
}

function redirect(location, cookies = []) {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

function cookie(name, value, { maxAge, path = "/" }) {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}
