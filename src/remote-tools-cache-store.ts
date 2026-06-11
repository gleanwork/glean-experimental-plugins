import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const CACHE_FILENAME = "remote-tools-cache.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function resolveCacheDir(): string {
  return process.env.PLUGIN_DATA_DIR || path.join(homedir(), ".glean");
}

function cacheFile(): string {
  return path.join(resolveCacheDir(), CACHE_FILENAME);
}

interface CacheEntry {
  tools: Tool[];
  fetchedAt: string;
}

type Store = Record<string, CacheEntry>;

function readStore(): Store {
  try {
    const raw = fs.readFileSync(cacheFile(), "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Store;
    }
    return {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  const filePath = cacheFile();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(dir, DIR_MODE);
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), {
    encoding: "utf-8",
    mode: FILE_MODE,
  });
  fs.chmodSync(filePath, FILE_MODE);
}

export function loadRemoteTools(serverUrl: string): Tool[] {
  if (!serverUrl) return [];
  const store = readStore();
  const entry = store[serverUrl];
  if (!entry || !Array.isArray(entry.tools)) return [];
  return entry.tools;
}

export function saveRemoteTools(serverUrl: string, tools: Tool[]): void {
  if (!serverUrl) return;
  try {
    const store = readStore();
    store[serverUrl] = { tools, fetchedAt: new Date().toISOString() };
    writeStore(store);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[remote-tools-cache] Failed to persist: ${msg}`);
  }
}

export function clearRemoteTools(serverUrl?: string): void {
  try {
    if (!serverUrl) {
      fs.rmSync(cacheFile(), { force: true });
      return;
    }
    const store = readStore();
    if (store[serverUrl] !== undefined) {
      delete store[serverUrl];
      if (Object.keys(store).length === 0) {
        fs.rmSync(cacheFile(), { force: true });
      } else {
        writeStore(store);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[remote-tools-cache] Failed to clear: ${msg}`);
  }
}
