import { sign, verify } from "./session.js";
import { authorizeUrl, identityFromCode } from "./github.js";
import { BOOTSTRAP_PAGE } from "./page.js";

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
  if (request.method === "GET" && (m = path.match(/^\/r\/[^/]+$/))) {
    return new Response(BOOTSTRAP_PAGE, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "cache-control": "no-store",
      },
    });
  }
  if (request.method === "POST" && (m = path.match(/^\/r\/([^/]+)\/open$/))) {
    return openResource(request, env, m[1]);
  }
  if (request.method === "GET" && path === "/auth/github/start") {
    return startLogin(env, url);
  }
  if (request.method === "GET" && path === "/auth/github/callback") {
    return finishLogin(request, env, deps, url);
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
    case "login":
      return Response.json({ login: `/auth/github/start?return=${encodeURIComponent(`/r/${id}`)}` }, { status: 401 });
    case "forbidden":
      return Response.json({ signedInAs: session.login }, { status: 403 });
    default:
      return Response.json({ error: "not found" }, { status: 404 });
  }
}

async function startLogin(env, url) {
  const nonce = crypto.randomUUID();
  const ret = safeReturn(url.searchParams.get("return"));
  const state = await sign({ nonce, ret }, env.SESSION_SECRET, OAUTH_TTL);
  return redirect(authorizeUrl(env, `${url.origin}/auth/github/callback`, nonce), [
    cookie("bp_oauth", state, { maxAge: OAUTH_TTL, path: "/auth/github" }),
  ]);
}

async function finishLogin(request, env, deps, url) {
  const pending = await verify(readCookie(request, "bp_oauth"), env.SESSION_SECRET);
  if (!pending || pending.nonce !== url.searchParams.get("state")) {
    return new Response("Login expired or did not match. Try again.", { status: 400 });
  }
  const identity = await identityFromCode(env, deps.fetch, url.searchParams.get("code"), `${url.origin}/auth/github/callback`);
  if (!identity) return new Response("GitHub did not accept the login.", { status: 400 });

  const session = await sign(identity, env.SESSION_SECRET, SESSION_TTL);
  return redirect(pending.ret, [
    cookie("bp_session", session, { maxAge: SESSION_TTL }),
    cookie("bp_oauth", "", { maxAge: 0, path: "/auth/github" }),
  ]);
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
