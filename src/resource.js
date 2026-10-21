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
        claimed_at   INTEGER,
        revoked_at   INTEGER
      );
    `);
    // Resources created before revocation existed lack the column.
    const cols = this.sql.exec(`PRAGMA table_info(invites)`).toArray().map((c) => c.name);
    if (!cols.includes("revoked_at")) this.sql.exec(`ALTER TABLE invites ADD COLUMN revoked_at INTEGER`);
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
    if (!invite || invite.revoked_at) return { status: "notfound" };
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

  // Invites are identified to admins by a prefix of the token hash, which
  // reveals nothing about the secret.
  async listInvites() {
    return this.sql.exec(`SELECT * FROM invites ORDER BY created_at`).toArray().map((r) => ({
      id: r.token_hash.slice(0, 12),
      expectEmail: r.expect_email,
      owner: r.owner,
      createdAt: r.created_at,
      claimedAt: r.claimed_at,
      revokedAt: r.revoked_at,
    }));
  }

  async revokeInvite(id) {
    if (!/^[0-9a-f]{12}$/.test(id)) return false;
    const cursor = this.sql.exec(
      `UPDATE invites SET revoked_at = ? WHERE substr(token_hash, 1, 12) = ? AND revoked_at IS NULL`,
      Date.now(), id,
    );
    return cursor.rowsWritten > 0;
  }
}

function randomToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
