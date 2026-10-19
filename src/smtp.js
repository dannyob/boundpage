// A minimal SMTP client for sending one plain-text message through an
// authenticated submission server (Purelymail by default) over implicit TLS.
// The socket comes from a connect() passed in by the caller, so this module
// does not depend on any one runtime's socket API.

export async function sendMail(env, { to, subject, text }, connect) {
  const from = env.MAIL_FROM;
  const domain = from.split("@")[1];
  const socket = connect(
    { hostname: env.SMTP_HOST || "smtp.purelymail.com", port: Number(env.SMTP_PORT || 465) },
    { secureTransport: "on" },
  );
  try {
    await converse(lineConnection(socket), {
      helo: domain,
      user: env.SMTP_USER || from,
      pass: env.SMTP_PASS,
      from,
      to,
      data: formatMessage({ from, to, subject, text, date: new Date(), messageId: `<${crypto.randomUUID()}@${domain}>` }),
    });
  } finally {
    await socket.close().catch(() => {});
  }
}

export function formatMessage({ from, to, subject, text, date, messageId }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  const body = text
    .replace(/\r?\n/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => (line.startsWith(".") ? "." + line : line));
  return [...headers, "", ...body].join("\r\n");
}

export async function converse(conn, { helo, user, pass, from, to, data }) {
  const step = async (command, okCodes, what) => {
    if (command) await conn.send(command);
    const r = await conn.reply();
    if (!okCodes.includes(r.code)) throw new Error(`SMTP ${what} failed: ${r.code} ${r.text}`);
  };
  await step(null, [220], "greeting");
  await step(`EHLO ${helo}\r\n`, [250], "EHLO");
  await step(`AUTH PLAIN ${base64(`\0${user}\0${pass}`)}\r\n`, [235], "AUTH");
  await step(`MAIL FROM:<${from}>\r\n`, [250], "MAIL FROM");
  await step(`RCPT TO:<${to}>\r\n`, [250, 251], "RCPT TO");
  await step("DATA\r\n", [354], "DATA");
  await step(`${data}\r\n.\r\n`, [250], "message");
  await step("QUIT\r\n", [221], "QUIT").catch(() => {});
}

// Wraps a { readable, writable } byte socket as send(text) / reply().
// A reply is one or more "NNN-text" lines ending with an "NNN text" line.
export function lineConnection(socket) {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  let buffer = "";

  async function readLine() {
    let end;
    while ((end = buffer.indexOf("\r\n")) === -1) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SMTP connection closed");
      buffer += decoder.decode(value, { stream: true });
    }
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return line;
  }

  return {
    send: (text) => writer.write(new TextEncoder().encode(text)),
    async reply() {
      const lines = [];
      let line;
      do {
        line = await readLine();
        lines.push(line.slice(4));
      } while (line[3] === "-");
      return { code: Number(line.slice(0, 3)), text: lines.join("\n") };
    },
  };
}

function base64(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64(value)}?=`;
}
