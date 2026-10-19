import { DurableObject } from "cloudflare:workers";
import { marked } from "marked";
import { b64url, sha256 } from "./util.js";

// One Resource per shared page. It holds the page content and a table of
// invites; each invite is a capability that latches to the first account
// allowed to claim it.
export class Resource extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS page (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        title        TEXT NOT NULL,
        content_type TEXT NOT NULL,
        content      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        token_hash   TEXT PRIMARY KEY,
        expect_email TEXT,
        owner        TEXT,
        created_at   INTEGER NOT NULL,
        claimed_at   INTEGER
      );
    `);
  }

  async setContent({ title, contentType, content }) {
    this.sql.exec(
      `INSERT OR REPLACE INTO page (id, title, content_type, content) VALUES (1, ?, ?, ?)`,
      title, contentType, content,
    );
  }

  // Returns the secret for the capability URL. Only its hash is stored.
  async mintInvite({ expectEmail }) {
    const secret = randomToken();
    this.sql.exec(
      `INSERT INTO invites (token_hash, expect_email, created_at) VALUES (?, ?, ?)`,
      await sha256(secret), expectEmail ? expectEmail.toLowerCase() : null, Date.now(),
    );
    return secret;
  }

  // identity is { sub, emails } from a verified login, or null.
  async open(secret, identity) {
    const hash = await sha256(String(secret));
    const invite = this.sql.exec(`SELECT * FROM invites WHERE token_hash = ?`, hash).toArray()[0];
    if (!invite) return { status: "notfound" };
    if (!identity) return { status: "login" };

    if (invite.owner) {
      if (invite.owner !== identity.sub) return { status: "forbidden" };
    } else {
      const emails = identity.emails.map((e) => e.toLowerCase());
      if (invite.expect_email && !emails.includes(invite.expect_email)) {
        return { status: "forbidden" };
      }
      this.sql.exec(
        `UPDATE invites SET owner = ?, claimed_at = ? WHERE token_hash = ?`,
        identity.sub, Date.now(), hash,
      );
    }

    const page = this.sql.exec(`SELECT * FROM page WHERE id = 1`).toArray()[0];
    const html = page.content_type === "text/markdown" ? marked.parse(page.content) : page.content;
    return { status: "ok", title: page.title, html };
  }
}

function randomToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
