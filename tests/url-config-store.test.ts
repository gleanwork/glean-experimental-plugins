import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "url-config-store-test-"));

vi.stubEnv("PLUGIN_DATA_DIR", tmpDir);

const { loadServerUrl, saveServerUrl, clearServerUrl } = await import(
  "../src/url-config-store.js"
);

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("url-config-store", () => {
  const configFile = path.join(tmpDir, "mcp-server-url.json");

  beforeEach(() => {
    try {
      fs.rmSync(configFile, { force: true });
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    try {
      fs.rmSync(configFile, { force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns undefined when config file does not exist", () => {
    expect(loadServerUrl()).toBeUndefined();
  });

  it("round-trips a saved URL", () => {
    saveServerUrl("https://acme-be.glean.com/mcp/gateway/proxy");
    expect(loadServerUrl()).toBe("https://acme-be.glean.com/mcp/gateway/proxy");
  });

  it("overwrites previous value", () => {
    saveServerUrl("https://old.glean.com/mcp/gateway/proxy");
    saveServerUrl("https://new.glean.com/mcp/gateway/proxy");
    expect(loadServerUrl()).toBe("https://new.glean.com/mcp/gateway/proxy");
  });

  it("clearServerUrl removes the file", () => {
    saveServerUrl("https://acme-be.glean.com/mcp/gateway/proxy");
    clearServerUrl();
    expect(loadServerUrl()).toBeUndefined();
  });

  it("clearServerUrl is a no-op when file does not exist", () => {
    expect(() => clearServerUrl()).not.toThrow();
  });

  it("returns undefined for malformed JSON", () => {
    fs.writeFileSync(configFile, "not json{{{", { encoding: "utf-8" });
    expect(loadServerUrl()).toBeUndefined();
  });

  it("returns undefined when serverUrl is empty string", () => {
    fs.writeFileSync(configFile, JSON.stringify({ serverUrl: "" }), {
      encoding: "utf-8",
    });
    expect(loadServerUrl()).toBeUndefined();
  });

  it("returns undefined when serverUrl is not a string", () => {
    fs.writeFileSync(configFile, JSON.stringify({ serverUrl: 12345 }), {
      encoding: "utf-8",
    });
    expect(loadServerUrl()).toBeUndefined();
  });

  it("sets restrictive file permissions", () => {
    saveServerUrl("https://acme-be.glean.com/mcp/gateway/proxy");
    const stat = fs.statSync(configFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
