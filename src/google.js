// Google sign-in (OpenID Connect authorization code flow), using only fetch.
//
// The ID token comes straight from Google's token endpoint over TLS, so its
// signature does not need checking (OpenID Connect Core 3.1.3.7); its issuer,
// audience and expiry still do.

const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export function authorizeUrl(env, redirectUri, state) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function identityFromCode(env, fetch, code, redirectUri) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const { id_token } = await res.json();
  if (!id_token) return null;

  const claims = decodeJwtPayload(id_token);
  if (!claims || !ISSUERS.includes(claims.iss) || claims.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (!(claims.exp * 1000 > Date.now()) || !claims.sub) return null;

  return {
    sub: `google:${claims.sub}`,
    login: claims.email || claims.name || claims.sub,
    emails: claims.email && claims.email_verified === true ? [claims.email] : [],
  };
}

function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(part), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
