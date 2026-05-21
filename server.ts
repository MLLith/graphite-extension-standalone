#!/usr/bin/env node
// Standalone host for the Graphite GTI VSCode extension. Loads the bundled
// extension via a fake `vscode` module, exposes the webview over HTTP+WS, and
// pipes messages between the browser and the gti server.
//
// The vendored bundle in graphite/ is run unchanged: we satisfy gti's contract
// by faking vscode (src/vscodeShim.ts), redirecting better-sqlite3 (below),
// and speaking gti's existing webview WS protocol. Nothing here patches the
// downloaded extension.

import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import * as childProcess from "child_process";
import Module from "module";
import { WebSocketServer, type WebSocket } from "ws";

import vscodeShim, { Uri } from "./src/vscodeShim";
import { WebviewBridge } from "./src/webviewBridge";
import { VSCODE_THEME_CSS } from "./src/vscodeTheme";
import { STANDALONE_CLIENT_JS } from "./src/standaloneClient";
import {
  PRESETS,
  detectPresets,
  getEditorChoice,
  getPersistedVSCodeConfig,
  getPending,
  clearPending,
  applyEditorChoice,
  parseEditorChoice,
  subscribe,
} from "./src/editorConfig";
import {
  listActiveNotifications,
  respondNotification,
  subscribeNotifications,
} from "./src/notifications";
import { getCurrentDiff, subscribeDiff } from "./src/diffRequests";

process.on("unhandledRejection", (e) => {
  // gti-server runs in-process; log and keep the host alive.
  console.error("[graphite-gui] unhandled rejection:", e instanceof Error ? e.stack : e);
});
process.on("uncaughtException", (e) => {
  console.error("[graphite-gui] uncaught exception:", e.stack ?? e);
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 0;
const HOST = process.env.HOST ?? "127.0.0.1";

const EXTENSION_ROOT = process.env.GRAPHITE_EXT_PATH
  ? path.resolve(process.env.GRAPHITE_EXT_PATH)
  : path.join(__dirname, "..", "graphite"); // compiled to dist/server.js

const WORKSPACE_DIR = path.resolve(process.env.GRAPHITE_CWD ?? process.argv[2] ?? process.cwd());

if (!fs.existsSync(path.join(EXTENSION_ROOT, "dist", "extension.js"))) {
  console.error(
    `Could not find Graphite extension bundle at ${EXTENSION_ROOT}.\n` +
      `Set GRAPHITE_EXT_PATH to override (default: ./graphite/).`,
  );
  process.exit(1);
}

const ModuleAny = Module as unknown as {
  _resolveFilename: (request: string, parent: NodeModule, ...rest: unknown[]) => string;
};
const origResolve = ModuleAny._resolveFilename.bind(Module);
// Resolve with the unpatched resolver so later require() calls don't recurse.
const VSCODE_SHIM_PATH = require.resolve("./src/vscodeShim");
const BETTER_SQLITE3_PATH = require.resolve("better-sqlite3");
const REDIRECTS = new Map<string, string>([
  ["vscode", VSCODE_SHIM_PATH], // bundled extension expects this module
  ["better-sqlite3", BETTER_SQLITE3_PATH], // vsix prebuilts don't cover every Node ABI
]);
ModuleAny._resolveFilename = function patchedResolve(request, parent, ...rest) {
  const redirect = REDIRECTS.get(request);
  if (redirect) return redirect;
  return origResolve(request, parent, ...rest);
};

const extensionWebviewDir = path.join(EXTENSION_ROOT, "dist", "webview");
vscodeShim.__registry.extensionWebviewDir = extensionWebviewDir;
vscodeShim.__registry.workspaceFolders = [
  {
    uri: Uri.file(WORKSPACE_DIR),
    name: path.basename(WORKSPACE_DIR),
    index: 0,
  },
];

const fakeContext = {
  subscriptions: [] as Array<{ dispose(): void }>,
  extensionUri: Uri.file(EXTENSION_ROOT),
};

function ensureSqliteAbi(): void {
  try {
    // eslint-disable-next-line import/no-unassigned-import -- Probe that the native binding can load for this Node ABI.
    require("better-sqlite3");
    return;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (!msg.includes("NODE_MODULE_VERSION")) throw e;
    const abi = process.versions.modules;
    console.error(
      `[graphite-gui] better-sqlite3 binary doesn't match Node ABI ${abi}. Rebuilding…`,
    );
    const pkgRoot = path.join(__dirname, "..");
    const rebuild = childProcess.spawnSync("npm", ["rebuild", "better-sqlite3"], {
      cwd: pkgRoot,
      stdio: "inherit",
    });
    if (rebuild.status !== 0) {
      console.error(
        `[graphite-gui] rebuild failed. Try manually: npm rebuild better-sqlite3 --prefix ${pkgRoot}`,
      );
      process.exit(1);
    }
    // Re-exec: this process cached the failed binding and can't reload it in-place.
    const child = childProcess.spawnSync(process.execPath, process.argv.slice(1), {
      stdio: "inherit",
    });
    process.exit(child.status ?? 0);
  }
}
ensureSqliteAbi();

console.log(`[graphite-gui] loading extension from ${EXTENSION_ROOT}`);
console.log(`[graphite-gui] workspace: ${WORKSPACE_DIR}`);

interface ExtensionModule {
  activate(context: typeof fakeContext): Promise<void>;
}

const extensionModule = require(
  path.join(EXTENSION_ROOT, "dist", "extension.js"),
) as ExtensionModule;

void (async () => {
  try {
    await extensionModule.activate(fakeContext);
    console.log("[graphite-gui] extension activated");
  } catch (e) {
    console.error("[graphite-gui] activate() failed:", e);
    process.exit(1);
  }
  startServer();
})();

function startServer(): void {
  const server = http.createServer(handleRequest);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    console.log("[graphite-gui] webview connected");
    const bridge = new WebviewBridge();
    vscodeShim.__registry.bridge = bridge;
    bridge.bindSocket(ws);

    // Each WS connection gets its own synthetic panel.
    void vscodeShim.commands.executeCommand("graphite.open-gti").catch((e) => {
      console.error("[graphite-gui] open-gti failed:", e);
    });

    ws.on("close", () => {
      console.log("[graphite-gui] webview disconnected");
      if (vscodeShim.__registry.bridge === bridge) {
        vscodeShim.__registry.bridge = null;
      }
    });
  });

  server.listen(PORT, HOST, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : PORT;
    const url = `http://${urlHost(HOST)}:${actualPort}/`;
    console.log(`[graphite-gui] listening on ${url}`);
    if (process.env.GRAPHITE_NO_OPEN) {
      console.log(`[graphite-gui] open ${url} in your browser`);
      return;
    }
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
      childProcess.spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
      console.log(`[graphite-gui] opening ${url} in your browser`);
    } catch (e) {
      console.log(`[graphite-gui] could not auto-open browser (${(e as Error).message})`);
      console.log(`[graphite-gui] open ${url} manually`);
    }
  });
}

function urlHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

const MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".json": "application/json",
};

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/" || pathname === "/index.html") {
    return serveIndex(res);
  }

  if (pathname.startsWith("/standalone/")) {
    return handleStandalone(pathname, req, res);
  }

  if (pathname.startsWith("/webview/")) {
    const rel = pathname.slice("/webview/".length);
    const full = path.join(extensionWebviewDir, rel);
    if (!full.startsWith(extensionWebviewDir)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    return serveFile(res, full);
  }

  if (pathname.startsWith("/asset/")) {
    const decoded = decodeURIComponent(pathname.slice("/asset/".length));
    return serveFile(res, decoded);
  }

  res.writeHead(404);
  res.end("not found");
}

function serveFile(res: http.ServerResponse, fullPath: string): void {
  fs.stat(fullPath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(fullPath).pipe(res);
  });
}

function handleStandalone(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (pathname === "/standalone/client.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(STANDALONE_CLIENT_JS);
    return;
  }

  if (pathname === "/standalone/diff-panel.js") {
    return serveFile(res, path.join(__dirname, "diff-panel.js"));
  }

  if (pathname === "/standalone/editor-config" && req.method === "GET") {
    const body = JSON.stringify({
      editor: getEditorChoice() ?? null,
      vscodeConfig: getPersistedVSCodeConfig(),
      pending: getPending(),
      presets: PRESETS.map((p) => ({ id: p.id, name: p.name, bin: p.bin })),
      detected: detectPresets(),
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(body);
    return;
  }

  if (pathname === "/standalone/editor-config" && req.method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) {
        res.writeHead(400);
        res.end("body too large");
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      let editor;
      let commandPath: string | undefined;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const body = text ? JSON.parse(text) : {};
        editor = body.editor === undefined ? undefined : parseEditorChoice(body.editor);
        if (body.vscodeConfig?.["graphite.commandPath"] !== undefined) {
          commandPath = String(body.vscodeConfig["graphite.commandPath"]);
        }
      } catch (e) {
        res.writeHead(400);
        res.end(`bad body: ${(e as Error).message}`);
        return;
      }
      if (editor === null) {
        res.writeHead(400);
        res.end("invalid editor");
        return;
      }
      if (commandPath !== undefined) {
        void vscodeShim.workspace.getConfiguration().update("graphite.commandPath", commandPath);
      }
      const result = editor ? applyEditorChoice(editor) : { openedPending: false };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, openedPending: result.openedPending }));
    });
    req.on("error", (e) => {
      res.writeHead(400);
      res.end(`bad body: ${(e as Error).message}`);
    });
    return;
  }

  if (pathname === "/standalone/editor-config/cancel" && req.method === "POST") {
    clearPending();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  if (pathname === "/standalone/notifications" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({ active: listActiveNotifications() }));
    return;
  }

  if (pathname === "/standalone/notifications/respond" && req.method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 16 * 1024) {
        res.writeHead(400);
        res.end("body too large");
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const body = text ? (JSON.parse(text) as { id?: unknown; title?: unknown }) : {};
        if (typeof body.id !== "string") {
          res.writeHead(400);
          res.end("missing id");
          return;
        }
        const title = typeof body.title === "string" ? body.title : undefined;
        const found = respondNotification(body.id, title);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: found }));
      } catch (e) {
        res.writeHead(400);
        res.end(`bad body: ${(e as Error).message}`);
      }
    });
    return;
  }

  if (pathname === "/standalone/diff" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({ diff: getCurrentDiff() }));
    return;
  }

  if (pathname === "/standalone/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    // SSE comments keep the connection alive through proxies and idle tabs.
    const keepalive = setInterval(() => {
      res.write(": ping\n\n");
    }, 25_000);
    const unsubscribe = subscribe(() => {
      res.write("event: pendingOpen\ndata: 1\n\n");
    });
    const unsubscribeNotifs = subscribeNotifications((n) => {
      res.write(`event: notification\ndata: ${JSON.stringify(n)}\n\n`);
    });
    const unsubscribeDiffs = subscribeDiff((d) => {
      res.write(`event: diff\ndata: ${JSON.stringify(d)}\n\n`);
    });
    // Replay still-open notifications so a refresh restores any open modals.
    for (const n of listActiveNotifications()) {
      res.write(`event: notification\ndata: ${JSON.stringify(n)}\n\n`);
    }
    // Diffs aren't replayed: a refresh wipes the panel and the user reopens
    // it from the UI if they want it back.
    req.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
      unsubscribeNotifs();
      unsubscribeDiffs();
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
}

function serveIndex(res: http.ServerResponse): void {
  // gti.js supports two transports: vscode postMessage (when acquireVsCodeApi
  // exists) and a built-in WebSocket fallback (when it doesn't). We omit
  // acquireVsCodeApi on purpose — the postMessage path listens on window and
  // chokes on stray messages (e.g. from browser extensions). WS is scoped.
  const html = `<!DOCTYPE html>
<html lang="en" class="vscode-dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <base href="/webview/">
  <title>Graphite GUI (standalone)</title>
  <style>${VSCODE_THEME_CSS}</style>
  <link href="gti.css" rel="stylesheet">
  <script>window.webpackNonce = "standalone";</script>
  <script defer src="gti.js"></script>
  <script defer src="/standalone/client.js"></script>
</head>
<body class="vscode-dark">
  <div id="root" class="webview-panel"></div>
</body>
</html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(html);
}
