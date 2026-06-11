import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GleanOAuthClientProvider } from "./auth-provider.js";

const GLEAN_PLUGIN = "GLEAN_PLUGIN";

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return bytes;
}

function encodeStringField(fieldNumber: number, value: string): number[] {
  if (!value) return [];
  const encoded = new TextEncoder().encode(value);
  const tag = (fieldNumber << 3) | 2;
  return [tag, ...encodeVarint(encoded.length), ...encoded];
}

function encodeMessageField(fieldNumber: number, inner: number[]): number[] {
  const tag = (fieldNumber << 3) | 2;
  return [tag, ...encodeVarint(inner.length), ...inner];
}

// Hand-rolled proto encoder for mcp.GatewayRequestMetadata. We don't currently
// have proto bindings in this repo, so the shape is hardcoded here. Cross-
// language parity is enforced by tests/remote-client.test.ts (byte-equality
// against the Go proto.Marshal output captured in scio's
// proxy_tools_provider_test.go::TestPluginGatewayRequestMetadata_NoSession).
//
// Proto layout (keep in sync with go/core/api/mcp/api.proto):
//   workflow_id      = field 1 (string)
//   chat_session_id  = field 2 (string)
//   source_info      = field 4 (core.SourceInfo)
//     platform         = field 2 (string)
//     client_initiator = field 3 (string)
export function buildGatewayMetadataHeader(chatSessionId?: string): string {
  const sourceInfo = [
    ...encodeStringField(2, GLEAN_PLUGIN),
    ...encodeStringField(3, GLEAN_PLUGIN),
  ];

  const message = [
    ...encodeStringField(1, GLEAN_PLUGIN),
    ...(chatSessionId ? encodeStringField(2, chatSessionId) : []),
    ...encodeMessageField(4, sourceInfo),
  ];

  return Buffer.from(new Uint8Array(message)).toString("base64");
}

function loggingFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const method = init?.method ?? "GET";
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  console.error(`[fetch] ${method} ${url}`);
  return fetch(input, init).then(
    (response) => {
      console.error(
        `[fetch] ${method} ${url} → ${response.status} ${response.statusText}`,
      );
      return response;
    },
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof Error && err.cause instanceof Error
          ? err.cause.message
          : String(err?.cause ?? "");
      console.error(`[fetch] ${method} ${url} → NETWORK ERROR: ${msg}`);
      if (cause) {
        console.error(`[fetch]   cause: ${cause}`);
      }
      throw err;
    },
  );
}

export interface RemoteClientOptions {
  authProvider?: GleanOAuthClientProvider;
}

export class AuthRequiredError extends Error {
  constructor(public readonly authUrl: string) {
    super("Authentication required");
  }
}

let pendingTransport: StreamableHTTPClientTransport | undefined;

function buildTransport(
  serverUrl: string,
  opts: RemoteClientOptions,
  chatSessionId?: string,
): StreamableHTTPClientTransport {
  const parsedUrl = new URL(serverUrl);
  const headers: Record<string, string> = {
    "X-Glean-Internal-Service": "true",
    "X-Glean-Gateway-Request-Metadata": buildGatewayMetadataHeader(chatSessionId),
  };

  const scParam = parsedUrl.searchParams.get("sc");
  if (scParam) {
    headers["X-Glean-Request-ScParams"] = scParam;
  }

  const transportOpts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {
    requestInit: { headers },
    fetch: loggingFetch,
  };

  if (opts.authProvider) {
    transportOpts.authProvider = opts.authProvider;
  }

  return new StreamableHTTPClientTransport(parsedUrl, transportOpts);
}

export async function createRemoteClient(
  serverUrl: string,
  opts: RemoteClientOptions,
  chatSessionId?: string,
): Promise<Client> {
  const authProvider = opts.authProvider;

  // Complete a pending auth flow if the user has authenticated in the browser.
  // Two shapes:
  //   (a) In-process — pendingTransport was set when a prior connect in this
  //       same process threw UnauthorizedError. Use it directly.
  //   (b) Cross-process — server was reaped after the first auth attempt.
  //       authProvider restored code_verifier + authorizationUrl from disk on
  //       construction, and the caller injected a pasted pendingAuthCode.
  //       Build a fresh transport for the exchange.
  if (authProvider?.pendingAuthCode) {
    const transportForAuth =
      pendingTransport ?? buildTransport(serverUrl, opts, chatSessionId);
    console.error("[auth] Auth code received, exchanging for tokens...");
    try {
      await transportForAuth.finishAuth(authProvider.pendingAuthCode);
      authProvider.clearPendingAuth();
      pendingTransport = undefined;
      console.error("[auth] Token exchange complete, reconnecting...");
      return createRemoteClient(serverUrl, opts, chatSessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[auth] Code exchange failed: ${msg} — discarding stale auth state`);
      authProvider.clearPendingAuth();
      pendingTransport = undefined;
      await authProvider.invalidateCredentials("all");
      return createRemoteClient(serverUrl, opts, chatSessionId);
    }
  }

  // DCR recovery: we previously issued an authorize URL but never received
  // tokens. The URL was likely rejected by the server (most commonly: the
  // cached DCR client was deleted server-side). Force a fresh DCR so the next
  // URL we generate uses a valid, server-known client_id.
  if (authProvider?.needsFreshClient()) {
    console.error("[auth] Previous auth URL didn't complete — forcing fresh DCR");
    await authProvider.invalidateCredentials("all");
  }

  const client = new Client(
    { name: "glean", version: "1.0.0" },
    { capabilities: {} },
  );

  const transport = buildTransport(serverUrl, opts, chatSessionId);

  try {
    await client.connect(transport);
  } catch (error) {
    if (error instanceof UnauthorizedError && authProvider?.authorizationUrl) {
      pendingTransport = transport;
      throw new AuthRequiredError(authProvider.authorizationUrl);
    }
    throw error;
  }

  return client;
}

export async function callRemoteTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const result = await client.callTool({ name, arguments: args });
  if (!("content" in result)) {
    return { content: [] };
  }
  return result as CallToolResult;
}
