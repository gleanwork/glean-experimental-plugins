import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-auth-test-"));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => tmpDir };
});

const { savePending, loadPending, deletePending } = await import(
  "../src/pending-auth-store.js"
);

describe("pending-auth-store", () => {
  const gleanDir = path.join(tmpDir, ".glean");

  beforeEach(() => {
    delete process.env.PLUGIN_DATA_DIR;
    fs.rmSync(gleanDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(gleanDir, { recursive: true, force: true });
  });

  it("returns undefined when no pending file exists", () => {
    expect(loadPending()).toBeUndefined();
  });

  it("savePending + loadPending round-trip", () => {
    savePending({
      codeVerifier: "verifier_abc",
      authorizationUrl: "https://idp.example.com/auth?state=xyz",
    });
    const loaded = loadPending();
    expect(loaded?.codeVerifier).toBe("verifier_abc");
    expect(loaded?.authorizationUrl).toBe(
      "https://idp.example.com/auth?state=xyz",
    );
    expect(typeof loaded?.savedAt).toBe("string");
  });

  it("deletePending removes the file", () => {
    savePending({
      codeVerifier: "v",
      authorizationUrl: "https://idp.example.com/auth",
    });
    expect(loadPending()).toBeDefined();
    deletePending();
    expect(loadPending()).toBeUndefined();
  });

  it("deletePending is a no-op when file is missing", () => {
    expect(() => deletePending()).not.toThrow();
  });

  it("writes the file with restrictive permissions (0600)", () => {
    savePending({
      codeVerifier: "v",
      authorizationUrl: "https://idp.example.com/auth",
    });
    const stat = fs.statSync(path.join(gleanDir, "pending-auth.json"));
    expect((stat.mode & 0o777).toString(8)).toBe("600");
  });

  it("prefers PLUGIN_DATA_DIR when set to a real path", () => {
    const altDir = fs.mkdtempSync(path.join(os.tmpdir(), "alt-plugin-data-"));
    try {
      process.env.PLUGIN_DATA_DIR = altDir;
      savePending({
        codeVerifier: "v",
        authorizationUrl: "https://idp.example.com/auth",
      });
      expect(fs.existsSync(path.join(altDir, "pending-auth.json"))).toBe(true);
      expect(fs.existsSync(path.join(gleanDir, "pending-auth.json"))).toBe(
        false,
      );
    } finally {
      fs.rmSync(altDir, { recursive: true, force: true });
    }
  });

  it("loadPending returns undefined for malformed JSON", () => {
    fs.mkdirSync(gleanDir, { recursive: true });
    fs.writeFileSync(path.join(gleanDir, "pending-auth.json"), "not json");
    expect(loadPending()).toBeUndefined();
  });

  it("loadPending returns undefined when required fields are missing", () => {
    fs.mkdirSync(gleanDir, { recursive: true });
    fs.writeFileSync(
      path.join(gleanDir, "pending-auth.json"),
      JSON.stringify({ savedAt: "2026-04-22T00:00:00Z" }),
    );
    expect(loadPending()).toBeUndefined();
  });
});
