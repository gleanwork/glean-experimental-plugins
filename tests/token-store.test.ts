import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock homedir before importing token-store so it uses a temp directory
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-store-test-"));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => tmpDir };
});

const { clearCredentials, loadCredentials, saveCredentials } = await import(
  "../src/token-store.js"
);

describe("token-store", () => {
  const gleanDir = path.join(tmpDir, ".glean");
  const credFile = path.join(gleanDir, "mcp-credentials.json");

  beforeEach(() => {
    fs.rmSync(gleanDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(gleanDir, { recursive: true, force: true });
  });

  it("returns undefined when credentials file does not exist", () => {
    expect(loadCredentials()).toBeUndefined();
  });

  it("saves and loads credentials round-trip", () => {
    const tokens = { access_token: "tok_123", token_type: "Bearer" };
    const clientInfo = { client_id: "cid_456" };

    saveCredentials(tokens, clientInfo);
    const loaded = loadCredentials();

    expect(loaded).toEqual({ tokens, clientInfo });
  });

  it("creates ~/.glean/ directory on first save", () => {
    expect(fs.existsSync(gleanDir)).toBe(false);

    saveCredentials({ access_token: "x" }, undefined);

    expect(fs.existsSync(gleanDir)).toBe(true);
  });

  it("sets credentials file to mode 0600", () => {
    saveCredentials({ access_token: "x" }, undefined);

    const stat = fs.statSync(credFile);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns undefined for corrupted JSON", () => {
    fs.mkdirSync(gleanDir, { recursive: true });
    fs.writeFileSync(credFile, "not-json{{{", "utf-8");

    expect(loadCredentials()).toBeUndefined();
  });

  it("overwrites existing credentials on save", () => {
    saveCredentials({ access_token: "old" }, { client_id: "old" });
    saveCredentials({ access_token: "new" }, { client_id: "new" });

    const loaded = loadCredentials();
    expect(loaded).toEqual({
      tokens: { access_token: "new" },
      clientInfo: { client_id: "new" },
    });
  });

  it("clearCredentials removes the persisted file", () => {
    saveCredentials({ access_token: "x" }, { client_id: "y" });
    expect(fs.existsSync(credFile)).toBe(true);

    clearCredentials();

    expect(fs.existsSync(credFile)).toBe(false);
    expect(loadCredentials()).toBeUndefined();
  });

  it("clearCredentials is a no-op when file does not exist", () => {
    expect(fs.existsSync(credFile)).toBe(false);
    expect(() => clearCredentials()).not.toThrow();
  });
});
