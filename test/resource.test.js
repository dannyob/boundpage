import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const alice = { sub: "github:1", emails: ["alice@example.com"] };
const bob = { sub: "github:2", emails: ["bob@example.com"] };

async function newResource(content = "<p>hello</p>", contentType = "text/html") {
  const stub = env.RESOURCE.get(env.RESOURCE.newUniqueId());
  await stub.setContent({ title: "Test page", contentType, content });
  return stub;
}

describe("Resource durable object", () => {
  it("rejects an unknown capability", async () => {
    const stub = await newResource();
    expect(await stub.open("not-a-real-cap", alice)).toEqual({ status: "notfound" });
  });

  it("asks for login when a valid capability is presented anonymously", async () => {
    const stub = await newResource();
    const cap = await stub.mintInvite({});
    expect(await stub.open(cap, null)).toEqual({ status: "login" });
  });

  it("latches a TOFU invite to the first person to open it", async () => {
    const stub = await newResource("<p>secret</p>");
    const cap = await stub.mintInvite({});

    const first = await stub.open(cap, alice);
    expect(first.status).toBe("ok");
    expect(first.html).toBe("<p>secret</p>");
    expect(first.title).toBe("Test page");

    expect(await stub.open(cap, bob)).toEqual({ status: "forbidden" });
    expect((await stub.open(cap, alice)).status).toBe("ok");
  });

  it("only lets the named person claim a targeted invite", async () => {
    const stub = await newResource();
    const cap = await stub.mintInvite({ expectEmail: "Alice@Example.com" });

    expect(await stub.open(cap, bob)).toEqual({ status: "forbidden" });
    // Bob's failed attempt must not have latched it
    expect((await stub.open(cap, alice)).status).toBe("ok");
  });

  it("keeps a targeted invite bound to the account after the email changes", async () => {
    const stub = await newResource();
    const cap = await stub.mintInvite({ expectEmail: "alice@example.com" });
    await stub.open(cap, alice);

    const aliceMoved = { sub: "github:1", emails: ["alice@elsewhere.org"] };
    expect((await stub.open(cap, aliceMoved)).status).toBe("ok");

    const impostor = { sub: "github:99", emails: ["alice@example.com"] };
    expect(await stub.open(cap, impostor)).toEqual({ status: "forbidden" });
  });

  it("latches each invite on a resource independently", async () => {
    const stub = await newResource();
    const capA = await stub.mintInvite({});
    const capB = await stub.mintInvite({});

    expect((await stub.open(capA, alice)).status).toBe("ok");
    expect((await stub.open(capB, bob)).status).toBe("ok");
    expect(await stub.open(capA, bob)).toEqual({ status: "forbidden" });
    expect(await stub.open(capB, alice)).toEqual({ status: "forbidden" });
  });

  it("renders markdown content to HTML", async () => {
    const stub = await newResource("# Heading\n\nSome *text*.", "text/markdown");
    const cap = await stub.mintInvite({});
    const { html } = await stub.open(cap, alice);
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<em>text</em>");
  });
});
