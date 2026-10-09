import { describe, it, expect } from "vitest";
import { sign, verify } from "../src/session.js";

const secret = "test-secret";

describe("signed tokens", () => {
  it("round-trips a payload", async () => {
    const token = await sign({ sub: "github:1" }, secret, 60);
    expect((await verify(token, secret)).sub).toBe("github:1");
  });

  it("rejects a token signed with another secret", async () => {
    const token = await sign({ sub: "github:1" }, "other-secret", 60);
    expect(await verify(token, secret)).toBeNull();
  });

  it("rejects a token whose payload was altered", async () => {
    const token = await sign({ sub: "github:1" }, secret, 60);
    const [, mac] = token.split(".");
    const [otherPayload] = (await sign({ sub: "github:2" }, "other-secret", 60)).split(".");
    const forged = otherPayload + "." + mac;
    expect(await verify(forged, secret)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await sign({ sub: "github:1" }, secret, -1);
    expect(await verify(token, secret)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verify("nonsense", secret)).toBeNull();
    expect(await verify(undefined, secret)).toBeNull();
  });
});
