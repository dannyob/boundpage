import { DurableObject } from "cloudflare:workers";
import { sha256 } from "./util.js";

const CODE_TTL = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const SEND_WINDOW = 60 * 60 * 1000;
const MAX_SENDS = 5;

// One EmailLogin per email address (idFromName). It holds at most one
// pending code, counts wrong guesses against it, and limits how many codes
// the address can be sent per hour.
export class EmailLogin extends DurableObject {
  async issue() {
    const now = Date.now();
    const sends = ((await this.ctx.storage.get("sends")) || []).filter((t) => t > now - SEND_WINDOW);
    if (sends.length >= MAX_SENDS) return { ok: false };

    const code = sixDigits();
    await this.ctx.storage.put({
      sends: [...sends, now],
      pending: { hash: await sha256(code), expires: now + CODE_TTL, attempts: 0 },
    });
    return { ok: true, code };
  }

  async verify(code) {
    const pending = await this.ctx.storage.get("pending");
    if (!pending) return false;
    if (pending.expires < Date.now() || pending.attempts >= MAX_ATTEMPTS) {
      await this.ctx.storage.delete("pending");
      return false;
    }
    if ((await sha256(String(code))) === pending.hash) {
      await this.ctx.storage.delete("pending");
      return true;
    }
    await this.ctx.storage.put("pending", { ...pending, attempts: pending.attempts + 1 });
    return false;
  }
}

// Uniform over 000000-999999: discard the top sliver of the 32-bit range.
function sixDigits() {
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= 4294000000);
  return String(buf[0] % 1000000).padStart(6, "0");
}
