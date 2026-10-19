import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { ORIGIN, call, cookieValue, share, open, outbox } from "./helpers.js";

const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function requestCode(id, cap, email) {
  return call("/auth/email/start", json({ resource: id, cap, email }));
}

function verifyCode(email, code) {
  return call("/auth/email/verify", json({ email, code }));
}

function lastCodeFor(email) {
  const msg = outbox.findLast((m) => m.to === email);
  return msg.text.match(/\b(\d{6})\b/)[1];
}

async function emailLogin(id, cap, email) {
  await requestCode(id, cap, email);
  const res = await verifyCode(email, lastCodeFor(email));
  return cookieValue(res, "bp_session");
}

function wrongCode(code) {
  return String((Number(code) + 1) % 1000000).padStart(6, "0");
}

describe("email code login", () => {
  it("is offered to anonymous visitors", async () => {
    const { id, cap } = await share();
    expect((await (await open(id, cap)).json()).email).toBe(true);
  });

  it("sends a six-digit code with a confirmation link that carries it in the fragment", async () => {
    const { id, cap } = await share();
    const res = await requestCode(id, cap, "Carol@Example.com");
    expect(res.status).toBe(200);

    const msg = outbox.findLast((m) => m.to === "carol@example.com");
    const code = lastCodeFor("carol@example.com");
    expect(msg.subject).toContain(code);
    expect(msg.text).toContain(`${ORIGIN}/auth/email/confirm#`);
    const link = new URL(msg.text.match(/https:\/\/\S+\/auth\/email\/confirm#\S+/)[0]);
    const params = new URLSearchParams(link.hash.slice(1));
    expect(params.get("code")).toBe(code);
    expect(params.get("return")).toBe(`/r/${id}`);
  });

  it("will not send a code without a valid capability", async () => {
    const { id } = await share();
    const before = outbox.length;
    expect((await requestCode(id, "wrong", "dave@example.com")).status).toBe(404);
    expect(outbox.length).toBe(before);
  });

  it("rejects addresses that could inject mail headers", async () => {
    const { id, cap } = await share();
    for (const bad of ["not-an-address", "a@b.c\r\nBcc: x@y.z", "a b@example.com", ""]) {
      expect((await requestCode(id, cap, bad)).status).toBe(400);
    }
  });

  it("limits how many codes one address can be sent", async () => {
    const { id, cap } = await share();
    for (let i = 0; i < 5; i++) expect((await requestCode(id, cap, "erin@example.com")).status).toBe(200);
    expect((await requestCode(id, cap, "erin@example.com")).status).toBe(429);
  });

  it("signs in with the right code, once", async () => {
    const { id, cap } = await share();
    await requestCode(id, cap, "frank@example.com");
    const code = lastCodeFor("frank@example.com");

    const res = await verifyCode("frank@example.com", code);
    expect(res.status).toBe(200);
    expect(cookieValue(res, "bp_session")).toBeTruthy();
    expect((await verifyCode("frank@example.com", code)).status).toBe(401);
  });

  it("refuses a wrong code", async () => {
    const { id, cap } = await share();
    await requestCode(id, cap, "gina@example.com");
    const res = await verifyCode("gina@example.com", wrongCode(lastCodeFor("gina@example.com")));
    expect(res.status).toBe(401);
    expect(cookieValue(res, "bp_session")).toBeUndefined();
  });

  it("burns the code after five wrong guesses", async () => {
    const { id, cap } = await share();
    await requestCode(id, cap, "hal@example.com");
    const code = lastCodeFor("hal@example.com");
    for (let i = 0; i < 5; i++) await verifyCode("hal@example.com", wrongCode(code));
    expect((await verifyCode("hal@example.com", code)).status).toBe(401);
  });

  it("refuses an expired code", async () => {
    const { id, cap } = await share();
    await requestCode(id, cap, "ivy@example.com");
    const code = lastCodeFor("ivy@example.com");
    const stub = env.EMAIL_LOGIN.get(env.EMAIL_LOGIN.idFromName("ivy@example.com"));
    await runInDurableObject(stub, async (_obj, state) => {
      const pending = await state.storage.get("pending");
      await state.storage.put("pending", { ...pending, expires: Date.now() - 1 });
    });
    expect((await verifyCode("ivy@example.com", code)).status).toBe(401);
  });

  it("latches a TOFU invite to the email address", async () => {
    const { id, cap } = await share();
    expect((await open(id, cap, await emailLogin(id, cap, "jo@example.com"))).status).toBe(200);
    expect((await open(id, cap, await emailLogin(id, cap, "kim@example.com"))).status).toBe(403);
  });

  it("lets the named person claim a targeted invite by email", async () => {
    const { id, cap } = await share({ expectEmail: "lee@example.com" });
    expect((await open(id, cap, await emailLogin(id, cap, "max@example.com"))).status).toBe(403);
    expect((await open(id, cap, await emailLogin(id, cap, "lee@example.com"))).status).toBe(200);
  });

  it("serves a confirmation page that does nothing until a button is pressed", async () => {
    const res = await call("/auth/email/confirm");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(cookieValue(res, "bp_session")).toBeUndefined();
  });
});
