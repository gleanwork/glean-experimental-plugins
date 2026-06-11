import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "remote-tools-cache-store-test-"),
);

vi.stubEnv("PLUGIN_DATA_DIR", tmpDir);

const { loadRemoteTools, saveRemoteTools, clearRemoteTools } = await import(
  "../src/remote-tools-cache-store.js"
);

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const cacheFile = path.join(tmpDir, "remote-tools-cache.json");

const URL_A = "https://acme-be.glean.com/mcp/gateway/proxy";
const URL_B = "https://other-be.glean.com/mcp/gateway/proxy";

const toolA: Tool = {
  name: "chat",
  description: "chat tool",
  inputSchema: { type: "object", properties: {} },
};
const toolB: Tool = {
  name: "search",
  description: "search tool",
  inputSchema: { type: "object", properties: {} },
};

describe("remote-tools-cache-store", () => {
  beforeEach(() => {
    try {
      fs.rmSync(cacheFile, { force: true });
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    try {
      fs.rmSync(cacheFile, { force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns [] when cache file does not exist", () => {
    expect(loadRemoteTools(URL_A)).toEqual([]);
  });

  it("round-trips tools for a server URL", () => {
    saveRemoteTools(URL_A, [toolA, toolB]);
    const loaded = loadRemoteTools(URL_A);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].name).toBe("chat");
    expect(loaded[1].name).toBe("search");
  });

  it("keeps separate entries per server URL", () => {
    saveRemoteTools(URL_A, [toolA]);
    saveRemoteTools(URL_B, [toolB]);
    expect(loadRemoteTools(URL_A).map((t) => t.name)).toEqual(["chat"]);
    expect(loadRemoteTools(URL_B).map((t) => t.name)).toEqual(["search"]);
  });

  it("overwrites the entry for the same URL", () => {
    saveRemoteTools(URL_A, [toolA]);
    saveRemoteTools(URL_A, [toolB]);
    expect(loadRemoteTools(URL_A).map((t) => t.name)).toEqual(["search"]);
  });

  it("records a fetchedAt ISO timestamp", () => {
    saveRemoteTools(URL_A, [toolA]);
    const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    expect(typeof raw[URL_A].fetchedAt).toBe("string");
    expect(() => new Date(raw[URL_A].fetchedAt)).not.toThrow();
  });

  it("returns [] for an unknown URL when other entries exist", () => {
    saveRemoteTools(URL_A, [toolA]);
    expect(loadRemoteTools(URL_B)).toEqual([]);
  });

  it("returns [] when serverUrl is empty", () => {
    saveRemoteTools(URL_A, [toolA]);
    expect(loadRemoteTools("")).toEqual([]);
  });

  it("saveRemoteTools is a no-op when serverUrl is empty", () => {
    saveRemoteTools("", [toolA]);
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  it("clearRemoteTools(url) removes only that entry", () => {
    saveRemoteTools(URL_A, [toolA]);
    saveRemoteTools(URL_B, [toolB]);
    clearRemoteTools(URL_A);
    expect(loadRemoteTools(URL_A)).toEqual([]);
    expect(loadRemoteTools(URL_B).map((t) => t.name)).toEqual(["search"]);
  });

  it("clearRemoteTools(url) deletes the file when the last entry is removed", () => {
    saveRemoteTools(URL_A, [toolA]);
    clearRemoteTools(URL_A);
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  it("clearRemoteTools() with no arg wipes the whole file", () => {
    saveRemoteTools(URL_A, [toolA]);
    saveRemoteTools(URL_B, [toolB]);
    clearRemoteTools();
    expect(fs.existsSync(cacheFile)).toBe(false);
    expect(loadRemoteTools(URL_A)).toEqual([]);
    expect(loadRemoteTools(URL_B)).toEqual([]);
  });

  it("clearRemoteTools is a no-op when file does not exist", () => {
    expect(() => clearRemoteTools()).not.toThrow();
    expect(() => clearRemoteTools(URL_A)).not.toThrow();
  });

  it("returns [] for malformed JSON", () => {
    fs.writeFileSync(cacheFile, "not json{{{", { encoding: "utf-8" });
    expect(loadRemoteTools(URL_A)).toEqual([]);
  });

  it("returns [] when entry tools is not an array", () => {
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ [URL_A]: { tools: "oops", fetchedAt: "now" } }),
      { encoding: "utf-8" },
    );
    expect(loadRemoteTools(URL_A)).toEqual([]);
  });

  it("sets restrictive file permissions", () => {
    saveRemoteTools(URL_A, [toolA]);
    const stat = fs.statSync(cacheFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
