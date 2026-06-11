import { describe, it, expect } from "vitest";
import { waitForAuthCode, getCallbackUrl } from "../src/auth-callback-server.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Tests run sequentially since they share port 29107.
// Each test waits for the promise to settle and the port to be released.
describe("auth-callback-server", () => {
  it("resolves with the authorization code", async () => {
    const pending = waitForAuthCode();
    await sleep(50);
    const res = await fetch(`${getCallbackUrl()}?code=abc123`);

    expect(res.status).toBe(200);
    expect(await pending).toBe("abc123");
    await sleep(50);
  });

  it("rejects when code is missing", async () => {
    const pending = waitForAuthCode();
    pending.catch(() => {});
    await sleep(50);
    const res = await fetch(getCallbackUrl());

    expect(res.status).toBe(400);
    await expect(pending).rejects.toThrow("no authorization code");
    await sleep(50);
  });

  it("accepts callback when state matches", async () => {
    const pending = waitForAuthCode("expected-state");
    await sleep(50);
    const res = await fetch(
      `${getCallbackUrl()}?code=abc&state=expected-state`,
    );

    expect(res.status).toBe(200);
    expect(await pending).toBe("abc");
    await sleep(50);
  });

  it("rejects callback when state does not match", async () => {
    const pending = waitForAuthCode("expected-state");
    pending.catch(() => {});
    await sleep(50);
    const res = await fetch(
      `${getCallbackUrl()}?code=abc&state=wrong-state`,
    );

    expect(res.status).toBe(403);
    await expect(pending).rejects.toThrow("state mismatch");
    await sleep(50);
  });

  it("skips state validation when no expected state is set", async () => {
    const pending = waitForAuthCode();
    await sleep(50);
    const res = await fetch(
      `${getCallbackUrl()}?code=abc&state=any-state`,
    );

    expect(res.status).toBe(200);
    expect(await pending).toBe("abc");
    await sleep(50);
  });

  it("returns 404 for non-callback paths", async () => {
    const pending = waitForAuthCode();
    await sleep(50);
    const baseUrl = getCallbackUrl().replace("/callback", "");
    const res = await fetch(`${baseUrl}/other`);

    expect(res.status).toBe(404);

    // Clean up: send valid request to close the server
    await fetch(`${getCallbackUrl()}?code=cleanup`);
    await pending;
    await sleep(50);
  });
});
