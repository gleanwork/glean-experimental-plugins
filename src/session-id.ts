import { randomUUID } from "node:crypto";

let fallbackSessionId: string | undefined;

/**
 * Resolves the chat session id from GLEAN_SESSION_ID, which the host-aware
 * launcher (start.sh) exports after reading whatever variable the current host
 * uses for the session/conversation id. The plugin itself stays host-agnostic
 * and never reads host-specific env vars.
 *
 * When no session id is provided (hosts that expose none, e.g. Cursor), a
 * plain RFC 4122 UUID is generated once per process so every call from this
 * process still shares one stable, non-hallucinated id. The fallback carries
 * no prefix so it stays a valid GUID if the backend ever validates
 * chat_session_id as one.
 */
export function resolveSessionId(): string {
  const fromHost = process.env.GLEAN_SESSION_ID?.trim();
  // Ignore empty/whitespace-only values and any un-interpolated "${VAR}"
  // placeholder a launcher might pass through verbatim.
  if (fromHost && !fromHost.startsWith("${")) {
    return fromHost;
  }
  if (!fallbackSessionId) {
    fallbackSessionId = randomUUID();
  }
  return fallbackSessionId;
}
