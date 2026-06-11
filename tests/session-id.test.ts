import { describe, it, expect, afterEach } from "vitest";
import { resolveSessionId } from "../src/session-id.js";

describe("resolveSessionId", () => {
  const saved = process.env.GLEAN_SESSION_ID;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.GLEAN_SESSION_ID;
    } else {
      process.env.GLEAN_SESSION_ID = saved;
    }
  });

  it("returns GLEAN_SESSION_ID when the launcher set it", () => {
    process.env.GLEAN_SESSION_ID = "host-session-123";
    expect(resolveSessionId()).toBe("host-session-123");
  });

  it("trims surrounding whitespace", () => {
    process.env.GLEAN_SESSION_ID = "  host-session-123  ";
    expect(resolveSessionId()).toBe("host-session-123");
  });

  it("ignores a whitespace-only value and falls back", () => {
    process.env.GLEAN_SESSION_ID = "   ";
    expect(resolveSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("ignores an un-interpolated ${...} placeholder and falls back", () => {
    process.env.GLEAN_SESSION_ID = "${GLEAN_SESSION_ID}";
    expect(resolveSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("falls back to a stable generated UUID when unset", () => {
    delete process.env.GLEAN_SESSION_ID;
    const first = resolveSessionId();
    expect(first).toBe(resolveSessionId());
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
