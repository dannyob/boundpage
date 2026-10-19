import { describe, it, expect } from "vitest";
import { formatMessage, converse, lineConnection } from "../src/smtp.js";

const MSG = {
  from: "share@libertyh.dev",
  to: "alice@example.com",
  subject: "Your code is 123456",
  text: "Hello\n.starts with a dot\nbye\n",
  date: new Date("2026-10-19T12:00:00Z"),
  messageId: "<abc@libertyh.dev>",
};

describe("formatMessage", () => {
  const raw = formatMessage(MSG);

  it("writes the headers a receiver expects", () => {
    expect(raw).toContain("From: share@libertyh.dev\r\n");
    expect(raw).toContain("To: alice@example.com\r\n");
    expect(raw).toContain("Subject: Your code is 123456\r\n");
    expect(raw).toContain("Date: Mon, 19 Oct 2026 12:00:00 +0000\r\n");
    expect(raw).toContain("Message-ID: <abc@libertyh.dev>\r\n");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8\r\n");
  });

  it("uses CRLF line endings only", () => {
    expect(raw.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("doubles a leading dot so it is not read as end of data", () => {
    expect(raw).toContain("\r\n..starts with a dot\r\n");
  });

  it("encodes a non-ASCII subject", () => {
    expect(formatMessage({ ...MSG, subject: "Café code" })).toContain("Subject: =?UTF-8?B?Q2Fmw6kgY29kZQ==?=\r\n");
  });
});

// A fake server: answers each command from a script and records what it got.
function scriptedServer(replies) {
  const received = [];
  let i = 0;
  return {
    received,
    async send(text) {
      received.push(text);
    },
    async reply() {
      return replies[i++];
    },
  };
}

const ok = (code) => ({ code, text: "ok" });

describe("converse", () => {
  it("authenticates and sends one message", async () => {
    const server = scriptedServer([ok(220), ok(250), ok(235), ok(250), ok(250), ok(354), ok(250), ok(221)]);
    await converse(server, { helo: "libertyh.dev", user: "share@libertyh.dev", pass: "pw", from: MSG.from, to: MSG.to, data: "DATA-BODY" });
    expect(server.received).toEqual([
      "EHLO libertyh.dev\r\n",
      `AUTH PLAIN ${btoa("\0share@libertyh.dev\0pw")}\r\n`,
      "MAIL FROM:<share@libertyh.dev>\r\n",
      "RCPT TO:<alice@example.com>\r\n",
      "DATA\r\n",
      "DATA-BODY\r\n.\r\n",
      "QUIT\r\n",
    ]);
  });

  it("stops with an error when authentication fails", async () => {
    const server = scriptedServer([ok(220), ok(250), { code: 535, text: "bad credentials" }]);
    await expect(
      converse(server, { helo: "h", user: "u", pass: "p", from: "a@b.cc", to: "c@d.ee", data: "x" }),
    ).rejects.toThrow(/535/);
    expect(server.received.some((c) => c.startsWith("MAIL FROM"))).toBe(false);
  });
});

describe("lineConnection", () => {
  function fakeSocket(chunks) {
    const written = [];
    return {
      written,
      readable: new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
          controller.close();
        },
      }),
      writable: new WritableStream({
        write(chunk) {
          written.push(new TextDecoder().decode(chunk));
        },
      }),
    };
  }

  it("reads multi-line replies split across chunks", async () => {
    const socket = fakeSocket(["220 hello\r\n250-smtp.example\r", "\n250-AUTH PLAIN\r\n250 SIZE 1000", "\r\n"]);
    const conn = lineConnection(socket);
    expect(await conn.reply()).toEqual({ code: 220, text: "hello" });
    expect(await conn.reply()).toEqual({ code: 250, text: "smtp.example\nAUTH PLAIN\nSIZE 1000" });
  });

  it("writes to the socket", async () => {
    const socket = fakeSocket([]);
    await lineConnection(socket).send("QUIT\r\n");
    expect(socket.written).toEqual(["QUIT\r\n"]);
  });
});
