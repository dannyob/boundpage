// The pages this Worker serves. Neither holds shared content.
//
// BOOTSTRAP_PAGE (/r/<id>): its script takes the capability from the URL
// fragment (or from localStorage on a return visit), POSTs it to
// /r/<id>/open, and shows whatever comes back. Shared content is shown in a
// sandboxed iframe without allow-same-origin, so scripts in it cannot read
// this origin's cookies or stored capabilities.
//
// CONFIRM_PAGE (/auth/email/confirm): opened from the link in a sign-in
// email. The code is in the fragment, and nothing is submitted until the
// person presses the button, so link scanners cannot use the code up.

const STYLE = `
  html, body { margin: 0; height: 100%; font: 16px/1.5 system-ui, sans-serif; }
  #message { max-width: 32rem; margin: 15vh auto; padding: 0 1rem; }
  #message button, #message a.button { font: inherit; padding: .5rem 1rem; cursor: pointer; }
  #message input { font: inherit; padding: .4rem .5rem; width: 16rem; max-width: 100%; }
  #message form { margin: 1rem 0; }
  #message .error { color: #b00020; }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
`;

export const BOOTSTRAP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>boundpage</title>
<style>${STYLE}</style>
</head>
<body>
<div id="message"><p>Loading…</p></div>
<script>
(async () => {
  const id = location.pathname.split("/")[2];
  const key = "boundpage-cap:" + id;
  const message = document.getElementById("message");
  const show = (html) => { message.innerHTML = html; };
  const post = (path, data) => fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });

  let cap = new URLSearchParams(location.hash.slice(1)).get("cap");
  if (cap) {
    try { localStorage.setItem(key, cap); } catch {}
    history.replaceState(null, "", location.pathname);
  } else {
    try { cap = localStorage.getItem(key); } catch {}
  }
  if (!cap) {
    show("<p>This page needs the link it was shared with. Open the original link again.</p>");
    return;
  }

  const res = await post(location.pathname + "/open", { cap });
  const body = await res.json().catch(() => ({}));

  if (res.status === 200) {
    document.title = body.title;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    frame.srcdoc = body.html;
    message.replaceWith(frame);
  } else if (res.status === 401) {
    show('<p>This page was shared with you. Sign in to open it; the link will then work only for your account.</p>' +
         '<p id="methods"></p>' +
         '<form id="email-form" hidden><label>Or get a code by email:<br>' +
         '<input id="email" type="email" autocomplete="email" required placeholder="you@example.com"></label> ' +
         '<button>Email me a code</button></form>' +
         '<form id="code-form" hidden><label>Enter the code we emailed to <b id="sent-to"></b>:<br>' +
         '<input id="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label> ' +
         '<button>Sign in</button></form>' +
         '<p id="error" class="error"></p>');
    const error = (text) => { document.getElementById("error").textContent = text; };
    for (const m of body.methods) {
      const a = document.createElement("a");
      a.className = "button";
      a.href = m.url;
      a.textContent = "Sign in with " + m.name;
      document.getElementById("methods").append(a, " ");
    }
    if (body.email) {
      const emailForm = document.getElementById("email-form");
      const codeForm = document.getElementById("code-form");
      let address;
      emailForm.hidden = false;
      emailForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        error("");
        address = document.getElementById("email").value;
        const r = await post("/auth/email/start", { resource: id, cap, email: address });
        if (r.status === 200) {
          document.getElementById("sent-to").textContent = address;
          emailForm.hidden = true;
          codeForm.hidden = false;
          document.getElementById("code").focus();
        } else {
          error((await r.json().catch(() => ({}))).error || "Could not send a code.");
        }
      });
      codeForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        error("");
        const r = await post("/auth/email/verify", { email: address, code: document.getElementById("code").value });
        if (r.status === 200) location.reload();
        else error("That code is wrong or has expired.");
      });
    }
  } else if (res.status === 403) {
    show("<p>This link belongs to a different account. You are signed in as <b></b>.</p>" +
         '<form method="post" action="/auth/logout?return=' + encodeURIComponent(location.pathname) + '">' +
         "<button>Sign out and use another account</button></form>");
    message.querySelector("b").textContent = body.signedInAs;
  } else {
    try { localStorage.removeItem(key); } catch {}
    show("<p>This link is not valid.</p>");
  }
})();
</script>
</body>
</html>
`;

export const CONFIRM_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>${STYLE}</style>
</head>
<body>
<div id="message">
  <p>Sign in as <b id="address"></b>?</p>
  <form id="confirm"><button>Sign in</button></form>
  <p id="error" class="error"></p>
</div>
<script>
(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);
  const email = params.get("email");
  const code = params.get("code");
  const ret = params.get("return") || "";
  if (!email || !code) {
    document.getElementById("message").textContent = "This sign-in link is incomplete.";
    return;
  }
  document.getElementById("address").textContent = email;
  document.getElementById("confirm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await fetch("/auth/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    if (r.status !== 200) {
      document.getElementById("error").textContent = "That code is wrong or has expired. Ask for a new one.";
      return;
    }
    location.href = /^\\/r\\/[0-9a-f]+$/.test(ret) ? ret : "/";
  });
})();
</script>
</body>
</html>
`;
