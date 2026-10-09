// GitHub OAuth (web application flow), using only fetch so it runs on
// any Workers-compatible runtime.

export function authorizeUrl(env, redirectUri, state) {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

// Exchanges an authorization code for an identity, or returns null.
export async function identityFromCode(env, fetch, code, redirectUri) {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const { access_token } = await tokenRes.json();
  if (!access_token) return null;

  const api = (path) =>
    fetch("https://api.github.com" + path, {
      headers: { authorization: `Bearer ${access_token}`, accept: "application/vnd.github+json", "user-agent": "boundpage" },
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub ${path}: ${r.status}`))));

  const [user, emails] = await Promise.all([api("/user"), api("/user/emails")]);
  return {
    sub: `github:${user.id}`,
    login: user.login,
    emails: emails.filter((e) => e.verified).map((e) => e.email),
  };
}
