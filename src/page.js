// The page served at /r/<id>. It holds no content: its script takes the
// capability from the URL fragment (or from localStorage on a return
// visit), POSTs it to /r/<id>/open, and shows whatever comes back.
//
// Shared content is shown in a sandboxed iframe without allow-same-origin,
// so scripts in it cannot read this origin's cookies or stored capabilities.

export const BOOTSTRAP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>boundpage</title>
<style>
  html, body { margin: 0; height: 100%; font: 16px/1.5 system-ui, sans-serif; }
  #message { max-width: 32rem; margin: 15vh auto; padding: 0 1rem; }
  #message button, #message a.button { font: inherit; padding: .5rem 1rem; cursor: pointer; }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<div id="message"><p>Loading…</p></div>
<script>
(async () => {
  const id = location.pathname.split("/")[2];
  const key = "boundpage-cap:" + id;
  const message = document.getElementById("message");
  const show = (html) => { message.innerHTML = html; };

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

  const res = await fetch(location.pathname + "/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cap }),
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 200) {
    document.title = body.title;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    frame.srcdoc = body.html;
    message.replaceWith(frame);
  } else if (res.status === 401) {
    show('<p>This page was shared with you. Sign in to open it; the link will then work only for your account.</p>' +
         '<p><a class="button" href="' + body.login + '">Sign in with GitHub</a></p>');
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
