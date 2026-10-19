import { connect } from "cloudflare:sockets";
import { handle } from "./app.js";
import { sendMail } from "./smtp.js";

export { Resource } from "./resource.js";
export { EmailLogin } from "./email-login.js";

export default {
  fetch(request, env) {
    return handle(request, env, {
      fetch: (...args) => fetch(...args),
      sendMail: (msg) => sendMail(env, msg, connect),
    });
  },
};
