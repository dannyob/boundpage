import { handle } from "./app.js";

export { Resource } from "./resource.js";
export { EmailLogin } from "./email-login.js";

export default {
  fetch(request, env) {
    return handle(request, env, { fetch: (...args) => fetch(...args) });
  },
};
