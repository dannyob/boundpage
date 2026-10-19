import * as github from "./github.js";
import * as google from "./google.js";

// OAuth sign-in providers. Each has authorizeUrl(env, redirectUri, state) and
// identityFromCode(env, fetch, code, redirectUri) -> { sub, login, emails } | null.
// A provider is offered only when its client id is configured.
const ALL = {
  github: { name: "GitHub", configured: (env) => Boolean(env.GITHUB_CLIENT_ID), ...github },
  google: { name: "Google", configured: (env) => Boolean(env.GOOGLE_CLIENT_ID), ...google },
};

export function provider(env, id) {
  const p = Object.hasOwn(ALL, id) ? ALL[id] : null;
  return p && p.configured(env) ? p : null;
}

export function configuredProviders(env) {
  return Object.entries(ALL)
    .filter(([, p]) => p.configured(env))
    .map(([id, p]) => ({ id, name: p.name }));
}
