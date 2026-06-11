import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const PENDING_FILENAME = "pending-auth.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function resolvePendingAuthDir(): string {
  return process.env.PLUGIN_DATA_DIR || path.join(homedir(), ".glean");
}

function pendingFile(): string {
  return path.join(resolvePendingAuthDir(), PENDING_FILENAME);
}

export interface PendingAuth {
  codeVerifier: string;
  authorizationUrl: string;
  savedAt: string;
}

export function savePending(
  data: Omit<PendingAuth, "savedAt">,
): void {
  try {
    const filePath = pendingFile();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
    const full: PendingAuth = { ...data, savedAt: new Date().toISOString() };
    fs.writeFileSync(filePath, JSON.stringify(full, null, 2), {
      encoding: "utf-8",
      mode: FILE_MODE,
    });
    fs.chmodSync(filePath, FILE_MODE);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[auth] Failed to persist pending auth: ${msg}`);
  }
}

export function loadPending(): PendingAuth | undefined {
  try {
    const raw = fs.readFileSync(pendingFile(), "utf-8");
    const parsed = JSON.parse(raw) as PendingAuth;
    if (
      typeof parsed?.codeVerifier !== "string" ||
      typeof parsed?.authorizationUrl !== "string" ||
      typeof parsed?.savedAt !== "string"
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function deletePending(): void {
  try {
    fs.unlinkSync(pendingFile());
  } catch {
    /* file may not exist */
  }
}
