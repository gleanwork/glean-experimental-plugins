import http from "node:http";

const CALLBACK_PORT = 29107;
const CALLBACK_PATH = "/callback";

let activeServer: http.Server | undefined;

function shutdownServer(server: http.Server): void {
  server.close();
  server.closeAllConnections();
  activeServer = undefined;
}

export function getCallbackUrl(): string {
  return `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
}

export function waitForAuthCode(expectedState?: string): Promise<string> {
  if (activeServer) {
    shutdownServer(activeServer);
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end();
        return;
      }

      if (expectedState) {
        const returnedState = url.searchParams.get("state");
        if (returnedState !== expectedState) {
          res.writeHead(403, { "Content-Type": "text/html" });
          res.end("<html><body><h1>Error</h1><p>Invalid OAuth state parameter.</p></body></html>");
          reject(new Error("OAuth state mismatch — possible CSRF attack"));
          shutdownServer(server);
          return;
        }
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Error</h1><p>No authorization code received.</p></body></html>");
        reject(new Error("no authorization code in OAuth callback"));
        shutdownServer(server);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Authentication successful</h1><p>You can close this tab.</p></body></html>");
      resolve(code);
      shutdownServer(server);
    });

    activeServer = server;

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      console.error(`[auth] Callback server listening on ${getCallbackUrl()}`);
    });
    server.on("error", (err) => {
      activeServer = undefined;
      reject(err);
    });
  });
}
