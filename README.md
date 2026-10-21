# boundpage

Share an HTML or Markdown page by sending someone a link. The first person to
sign in with that link owns it; after that the link only works for them.

```sh
$ export BOUNDPAGE_URL=https://share.example.com
$ export BOUNDPAGE_ADMIN_TOKEN=...
$ bin/boundpage share notes.md --for alice@example.com
resource: 8f3c1e…
https://share.example.com/r/8f3c1e…#cap=3E9N6QFL-hwykol1wzFVHkBa2T6VQP30EnkPeHPnESI
```

Alice opens that, signs in with GitHub, Google, or a code emailed to her, and
sees the page. Anyone else who gets hold of the link sees "This link belongs to
a different account." Leave off `--for` and the link goes to whoever signs in
first instead.

```sh
$ bin/boundpage invites 8f3c1e…
INVITE        FOR                OWNER                 CLAIMED           REVOKED
ac6740f1f11e  alice@example.com  google:1034…          2026-10-21 22:40  -
$ bin/boundpage revoke 8f3c1e… ac6740f1f11e
$ bin/boundpage update 8f3c1e… notes-v2.md     # links keep working
```

It runs on Cloudflare Workers with one Durable Object per page. The
capability travels in the URL fragment, so it never reaches a server log, a
proxy, or a `Referer` header. I wrote it to learn Durable Objects, and to see
whether the result would move to [celld](https://github.com/denoland/celld)
later; see [Running elsewhere](#running-elsewhere).

## Install

```sh
npm install
make test          # 68 tests, run inside workerd
make dev           # http://localhost:8787
```

The CLI is a single Python file with no dependencies, run with `uv`.

## Setup

Four secrets, plus one per sign-in method you want. Locally they go in
`.dev.vars` (copy `.dev.vars.example`); in production, `npx wrangler secret
put NAME`.

| Secret | What it is |
|---|---|
| `ADMIN_TOKEN` | Bearer token for `/admin/*` and the CLI. Anything long and random. |
| `SESSION_SECRET` | Signs the session and OAuth-state cookies. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | An [OAuth app](https://github.com/settings/applications/new) with callback `https://HOST/auth/github/callback`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | A "Web application" client in Google Cloud Console with redirect URI `https://HOST/auth/google/callback`, scopes `openid email profile`, consent screen published. |
| `SMTP_PASS` | Password for the mailbox in `MAIL_FROM` (set in `wrangler.toml`). Enables emailed codes. |

A sign-in method is offered only when its secret is set. Email codes go out
over SMTP with implicit TLS on port 465 (Purelymail by default; override
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`). Whoever receives the mail will
want SPF and DKIM records for the sending domain.

GitHub only accepts one callback URL per OAuth app, so local development
needs its own app pointing at `http://localhost:8787`.

## How the latch works

Each page is a Durable Object holding the content and a table of invites.
An invite stores only the SHA-256 of its secret, an optional expected
email, and, once claimed, the owner's account ID (`github:123`,
`google:…`, `email:alice@example.com`).

```
open(secret, identity):
  no such invite, or revoked        -> not found
  not signed in                     -> sign in
  already claimed by someone else   -> forbidden
  expected email set and not among
    the identity's verified emails  -> forbidden
  otherwise                         -> latch to this identity, show page
```

Durable Objects run one request at a time, so two people opening the same
link at the same moment can't both claim it.

Two things keep the secret off the wire. The page at `/r/<id>` holds no
content; its script reads `#cap=` from the fragment, stores it in
`localStorage`, strips it from the address bar, and POSTs it to
`/r/<id>/open`. Sign-in returns to the bare `/r/<id>` URL, and the script
picks the capability back up from storage, so it is never sent to GitHub or
Google. Shared content is rendered in a sandboxed iframe without
`allow-same-origin`, so a script in a shared page cannot read the viewer's
cookies or stored capabilities.

Emailed codes are six digits, hashed, good for ten minutes and five guesses.
A code can only be requested with a valid capability, so the site can't be
used to mail strangers, and each address gets at most five codes an hour.
The email also carries a link that pre-fills the code but waits for a button
press, so link-scanning mail filters can't spend it.

## Running elsewhere

Nothing here depends on KV, R2, Queues, or Cloudflare Access. The only
Cloudflare-specific API is `connect()` from `cloudflare:sockets`, used for
SMTP, and it is passed in from `src/index.js` so the mailer can be swapped
for an HTTP mail API. Whether this actually runs on celld is still to be
tried.

## Not done

No way to delete a page, no terms-of-service page, no Apple or Microsoft
sign-in, and no tests for the CLI beyond running it. Pages are rendered with
`marked` and shown as-is; if you share untrusted HTML, the iframe sandbox is
what protects viewers.

## License

MIT.
