// Fake `vscode` module covering the surface Graphite GTI actually uses.

import path from "path";
import fs from "fs";
import * as childProcess from "child_process";
import { pathToFileURL, fileURLToPath } from "url";

import type { WebviewBridge } from "./webviewBridge";
import { getPersistedVSCodeConfig, persistVSCodeConfig, requestOpen } from "./editorConfig";
import { enqueueNotification, type NotificationItem, type Severity } from "./notifications";
import { enqueueDiff } from "./diffRequests";

// ---------------------------------------------------------------------------
// Internal registry shared across the shim. server.ts populates `bridge` and
// `extensionWebviewDir` before triggering open-gti.
// ---------------------------------------------------------------------------

type CommandHandler = (...args: unknown[]) => unknown;
type Listener<T> = (value: T) => unknown;

interface WorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

interface TextDocumentContentProvider {
  provideTextDocumentContent(uri: Uri, token?: unknown): unknown;
}

interface Registry {
  commands: Map<string, CommandHandler>;
  configChangeEmitter: EventEmitter<ConfigurationChangeEvent>;
  workspaceFoldersChangeEmitter: EventEmitter<WorkspaceFoldersChangeEvent>;
  closeTextDocumentEmitter: EventEmitter<unknown>;
  workspaceFolders: WorkspaceFolder[];
  config: Record<string, unknown>;
  bridge: WebviewBridge | null;
  extensionWebviewDir: string | null;
  contentProviders: Map<string, TextDocumentContentProvider>;
}

interface ConfigurationChangeEvent {
  affectsConfiguration: (section: string) => boolean;
}
interface WorkspaceFoldersChangeEvent {
  added: readonly WorkspaceFolder[];
  removed: readonly WorkspaceFolder[];
}

interface Disposable {
  dispose(): void;
}

class EventEmitter<T> {
  private listeners = new Set<Listener<T>>();

  event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const l of this.listeners) l(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

const registry: Registry = {
  commands: new Map(),
  configChangeEmitter: new EventEmitter<ConfigurationChangeEvent>(),
  workspaceFoldersChangeEmitter: new EventEmitter<WorkspaceFoldersChangeEvent>(),
  closeTextDocumentEmitter: new EventEmitter<unknown>(),
  workspaceFolders: [],
  config: {
    ...getPersistedVSCodeConfig(),
    "graphite.gti.showInSidebar": false,
  },
  bridge: null,
  extensionWebviewDir: null,
  contentProviders: new Map(),
};

class DisposableImpl implements Disposable {
  private fn: (() => void) | null;
  constructor(fn: () => void) {
    this.fn = fn;
  }
  dispose(): void {
    if (this.fn) {
      this.fn();
      this.fn = null;
    }
  }
  static from(...disposables: Array<{ dispose?(): void } | undefined>): DisposableImpl {
    return new DisposableImpl(() => {
      for (const d of disposables) d?.dispose?.();
    });
  }
}

// ---------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------

interface UriParts {
  scheme?: string;
  authority?: string;
  path?: string;
  query?: string;
  fragment?: string;
}

class Uri {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
  /** Set by asWebviewUri so that toString() returns a host-relative URL. */
  _overrideString?: string;

  constructor({
    scheme = "file",
    authority = "",
    path: p = "",
    query = "",
    fragment = "",
  }: UriParts) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = p;
    this.query = query;
    this.fragment = fragment;
  }

  get fsPath(): string {
    if (this.scheme !== "file") return this.path;
    return fileURLToPath(this.toString(true));
  }

  with(change: UriParts): Uri {
    return new Uri({
      scheme: change.scheme ?? this.scheme,
      authority: change.authority ?? this.authority,
      path: change.path ?? this.path,
      query: change.query ?? this.query,
      fragment: change.fragment ?? this.fragment,
    });
  }

  toString(_skipEncoding?: boolean): string {
    if (this._overrideString) return this._overrideString;
    let r = `${this.scheme}://${this.authority}${this.path}`;
    if (this.query) r += `?${encodeURIComponent(this.query)}`;
    if (this.fragment) r += `#${encodeURIComponent(this.fragment)}`;
    return r;
  }

  toJSON(): object {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
      fsPath: this.fsPath,
    };
  }

  static file(p: string): Uri {
    const url = pathToFileURL(p);
    return new Uri({ scheme: "file", path: url.pathname });
  }

  static parse(value: string): Uri {
    try {
      const u = new URL(value);
      return new Uri({
        scheme: u.protocol.replace(/:$/, ""),
        authority: u.host,
        path: u.pathname,
        query: u.search.replace(/^\?/, ""),
        fragment: u.hash.replace(/^#/, ""),
      });
    } catch {
      const m = /^([^:]+):(.*)$/.exec(value);
      if (m) return new Uri({ scheme: m[1], path: m[2] });
      return Uri.file(value);
    }
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri({ ...base, path: path.posix.join(base.path, ...parts) });
  }
}

// ---------------------------------------------------------------------------
// Enums + geometry types
// ---------------------------------------------------------------------------

const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
} as const;

const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

const TextEditorRevealType = {
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
} as const;

class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}

class Range {
  start: Position;
  end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === "number") {
      this.start = new Position(a, b as number);
      this.end = new Position(c as number, d as number);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
}

class Selection extends Range {}

class RelativePattern {
  baseUri: Uri;
  base: string;
  pattern: string;
  constructor(base: Uri | string | WorkspaceFolder, pattern: string) {
    if (base instanceof Uri) {
      this.baseUri = base;
    } else if (typeof base === "string") {
      this.baseUri = Uri.file(base);
    } else {
      this.baseUri = Uri.file(base.uri.fsPath);
    }
    this.base = this.baseUri.fsPath;
    this.pattern = pattern;
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const commands = {
  registerCommand(id: string, handler: CommandHandler): Disposable {
    registry.commands.set(id, handler);
    return new DisposableImpl(() => {
      if (registry.commands.get(id) === handler) registry.commands.delete(id);
    });
  },
  executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    const handler = registry.commands.get(id);
    if (!handler) {
      if (process.env.GRAPHITE_GUI_DEBUG) {
        console.warn(`[shim] executeCommand("${id}") — no handler`);
      }
      return Promise.resolve(undefined);
    }
    return Promise.resolve(handler(...args));
  },
};

// ---------------------------------------------------------------------------
// window — OutputChannel + WebviewPanel + a handful of message boxes
// ---------------------------------------------------------------------------

// VSCode signatures:
//   show*Message(message, ...items)
//   show*Message(message, options, ...items)
// `items` may be strings or { title, isCloseAffordance? } objects. We
// serialize items as { title } for the browser, but return the original
// input (string or object) at the matching index so callers can compare by
// reference or by string equality, matching VSCode.
function showMessage(severity: Severity, message: string, rawArgs: unknown[]): Promise<unknown> {
  let modal = false;
  let detail: string | undefined;
  let itemArgs = rawArgs;
  const first = rawArgs[0];
  if (
    first !== null &&
    typeof first === "object" &&
    !Array.isArray(first) &&
    ("modal" in first || "detail" in first)
  ) {
    const opts = first as { modal?: unknown; detail?: unknown };
    modal = opts.modal === true;
    detail = typeof opts.detail === "string" ? opts.detail : undefined;
    itemArgs = rawArgs.slice(1);
  }
  const items: NotificationItem[] = [];
  const originals: unknown[] = [];
  for (const it of itemArgs) {
    if (typeof it === "string") {
      items.push({ title: it });
      originals.push(it);
    } else if (it !== null && typeof it === "object" && "title" in it) {
      const obj = it as { title: unknown; isCloseAffordance?: unknown };
      if (typeof obj.title === "string") {
        items.push({ title: obj.title, isCloseAffordance: obj.isCloseAffordance === true });
        originals.push(it);
      }
    }
  }

  const logger = severity === "error" ? console.error : console.log;
  logger(`[gti ${severity}] ${message}${detail ? ` — ${detail}` : ""}`);

  return enqueueNotification(severity, message, detail, modal, items).then((title) => {
    if (title === undefined) return undefined;
    const idx = items.findIndex((it) => it.title === title);
    return idx >= 0 ? originals[idx] : undefined;
  });
}

interface WebviewOptions {
  enableScripts?: boolean;
  retainContextWhenHidden?: boolean;
  localResourceRoots?: Uri[];
}

class WebviewLike {
  options: WebviewOptions;
  cspSource = "self";
  _html = "";
  _messageEmitter = new EventEmitter<unknown>();
  onDidReceiveMessage: EventEmitter<unknown>["event"];
  private _bridge: WebviewBridge | null;

  constructor(bridge: WebviewBridge | null, options?: WebviewOptions) {
    this._bridge = bridge;
    this.options = options ?? { enableScripts: true };
    this.onDidReceiveMessage = this._messageEmitter.event;
  }

  get html(): string {
    return this._html;
  }
  set html(value: string) {
    this._html = value;
    if (this._bridge) this._bridge.setHtml(value);
  }

  postMessage(message: unknown): Promise<boolean> {
    if (this._bridge) return this._bridge.postToClient(message);
    return Promise.resolve(false);
  }

  asWebviewUri(uri: Uri): Uri {
    // The extension calls this on the dist/webview directory and uses the
    // result as the <base href>. Map that single case to our /webview/ mount;
    // anything else gets a generic /asset/<absPath> route.
    if (uri instanceof Uri && uri.scheme === "file") {
      const fsPath = uri.fsPath;
      const u = new Uri({ scheme: "http", authority: "asset" });
      if (registry.extensionWebviewDir && fsPath === registry.extensionWebviewDir) {
        u._overrideString = "/webview";
      } else {
        u._overrideString = "/asset/" + encodeURIComponent(fsPath);
      }
      return u;
    }
    return uri;
  }
}

class WebviewPanelLike {
  viewType: string;
  title: string;
  webview: WebviewLike;
  active = true;
  visible = true;
  iconPath: Uri | undefined;
  onDidDispose: EventEmitter<void>["event"];
  private _disposeEmitter = new EventEmitter<void>();
  private _disposed = false;
  private _bridge: WebviewBridge | null;

  constructor(
    viewType: string,
    title: string,
    bridge: WebviewBridge | null,
    options?: WebviewOptions,
  ) {
    this.viewType = viewType;
    this.title = title;
    this._bridge = bridge;
    this.webview = new WebviewLike(bridge, options);
    this.onDidDispose = this._disposeEmitter.event;
    if (bridge) bridge.attachPanel(this);
  }

  reveal(): void {
    if (this._bridge) this._bridge.focus();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._disposeEmitter.fire();
    this._disposeEmitter.dispose();
    this.webview._messageEmitter.dispose();
  }
}

const window = {
  activeTextEditor: undefined as unknown,
  createOutputChannel(name: string, _options?: unknown) {
    return {
      name,
      debug: (msg: string, ...rest: unknown[]) => console.log(`[gti debug] ${msg}`, ...rest),
      info: (msg: string, ...rest: unknown[]) => console.log(`[gti info] ${msg}`, ...rest),
      warn: (msg: string, ...rest: unknown[]) => console.warn(`[gti warn] ${msg}`, ...rest),
      error: (msg: string, ...rest: unknown[]) => console.error(`[gti error] ${msg}`, ...rest),
      trace: (msg: string, ...rest: unknown[]) => console.log(`[gti trace] ${msg}`, ...rest),
      append: (v: string) => process.stdout.write(v),
      appendLine: (v: string) => console.log(v),
      replace: () => {},
      clear: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {},
    };
  },
  createWebviewPanel(
    viewType: string,
    title: string,
    _showOptions: unknown,
    options?: WebviewOptions,
  ): WebviewPanelLike {
    return new WebviewPanelLike(viewType, title, registry.bridge, options);
  },
  registerWebviewPanelSerializer(_viewType: string, _serializer: unknown): Disposable {
    return new DisposableImpl(() => {});
  },
  registerWebviewViewProvider(_viewType: string, _provider: unknown): Disposable {
    return new DisposableImpl(() => {});
  },
  showInformationMessage(message: string, ...args: unknown[]): Promise<unknown> {
    return showMessage("info", message, args);
  },
  showWarningMessage(message: string, ...args: unknown[]): Promise<unknown> {
    return showMessage("warn", message, args);
  },
  showErrorMessage(message: string, ...args: unknown[]): Promise<unknown> {
    return showMessage("error", message, args);
  },
  showTextDocument(uri: Uri | string): Promise<unknown> {
    const target = uri instanceof Uri ? uri.fsPath : String(uri);
    // The bundle pattern is:
    //   const i = window.showTextDocument(o);
    //   if (line != null) { const e = await i; e.selections = ...; e.revealRange(range, ...); }
    // We want a single launch with the right `:line` suffix. Defer the
    // actual open until either (a) revealRange is called (line was set),
    // or (b) one tick has passed (no line target). Whichever happens
    // first wins; `launched` deduplicates.
    let launched = false;
    const launch = (line?: number): void => {
      if (launched) return;
      launched = true;
      requestOpen(target, line);
    };
    setImmediate(() => launch());
    return Promise.resolve({
      selections: [] as unknown[],
      revealRange: (range?: { start?: { line?: number } }): void => {
        const zeroBased = range?.start?.line;
        launch(typeof zeroBased === "number" ? zeroBased + 1 : undefined);
      },
      document: { uri },
    });
  },
};

// ---------------------------------------------------------------------------
// workspace — configuration + file watcher + workspace folders
// ---------------------------------------------------------------------------

function makeConfig(section?: string) {
  const prefix = section ? `${section}.` : "";
  return {
    get(key: string, defaultValue?: unknown): unknown {
      const full = prefix + key;
      return registry.config[full] !== undefined ? registry.config[full] : defaultValue;
    },
    update(key: string, value: unknown, _target?: unknown): Promise<void> {
      const full = prefix + key;
      const before = registry.config[full];
      registry.config[full] = value;
      persistVSCodeConfig(full, value);
      if (before !== value) {
        registry.configChangeEmitter.fire({
          affectsConfiguration: (s) => full === s || full.startsWith(s + "."),
        });
      }
      return Promise.resolve();
    },
    has(key: string): boolean {
      return prefix + key in registry.config;
    },
    inspect(): undefined {
      return undefined;
    },
  };
}

// Cheap recursive fs watcher. On Linux, fs.watch({recursive:true}) is unsupported
// so we fall back to shallow-only — the extension mostly cares about repo root + .git.
function createFileSystemWatcher(globPattern: RelativePattern | string) {
  const basePath = globPattern instanceof RelativePattern ? globPattern.base : String(globPattern);
  const changeEmitter = new EventEmitter<Uri>();
  const createEmitter = new EventEmitter<Uri>();
  const deleteEmitter = new EventEmitter<Uri>();

  let disposed = false;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(basePath, { recursive: process.platform !== "linux" }, (event, filename) => {
      if (!filename || disposed) return;
      const fullPath = path.join(basePath, filename.toString());
      const uri = Uri.file(fullPath);
      if (event === "rename") {
        fs.stat(fullPath, (err) => {
          if (err) deleteEmitter.fire(uri);
          else createEmitter.fire(uri);
        });
      } else {
        changeEmitter.fire(uri);
      }
    });
    watcher.on("error", (e) => console.warn(`[shim] watcher error: ${e.message}`));
  } catch (e) {
    console.warn(`[shim] failed to watch ${basePath}:`, (e as Error).message);
  }

  return {
    onDidChange: changeEmitter.event,
    onDidCreate: createEmitter.event,
    onDidDelete: deleteEmitter.event,
    dispose() {
      disposed = true;
      watcher?.close();
      changeEmitter.dispose();
      createEmitter.dispose();
      deleteEmitter.dispose();
    },
  };
}

const workspace = {
  get workspaceFolders(): WorkspaceFolder[] {
    return registry.workspaceFolders;
  },
  onDidChangeWorkspaceFolders(listener: Listener<WorkspaceFoldersChangeEvent>): Disposable {
    return registry.workspaceFoldersChangeEmitter.event(listener);
  },
  onDidChangeConfiguration(listener: Listener<ConfigurationChangeEvent>): Disposable {
    return registry.configChangeEmitter.event(listener);
  },
  onDidCloseTextDocument(listener: Listener<unknown>): Disposable {
    return registry.closeTextDocumentEmitter.event(listener);
  },
  getConfiguration(section?: string) {
    return makeConfig(section);
  },
  registerTextDocumentContentProvider(scheme: string, provider: unknown): Disposable {
    registry.contentProviders.set(scheme, provider as TextDocumentContentProvider);
    return new DisposableImpl(() => {
      if (registry.contentProviders.get(scheme) === provider) {
        registry.contentProviders.delete(scheme);
      }
    });
  },
  createFileSystemWatcher,
};

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

const env = {
  openExternal(uri: Uri | string): Promise<boolean> {
    const target = uri instanceof Uri ? uri.toString() : String(uri);
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    childProcess.spawn(opener, [target], { detached: true, stdio: "ignore" }).unref();
    return Promise.resolve(true);
  },
  appName: "Graphite GUI Standalone",
  uriScheme: "graphite-gui",
};

// vscode.diff(leftUri, rightUri, title) is normally a built-in. The Graphite
// extension calls it to open a comparison editor; here we resolve both sides
// through the registered TextDocumentContentProvider (or fs for file://) and
// push the result to the browser where the diff renders in a panel.
async function readUri(uri: Uri): Promise<string> {
  if (uri.scheme === "file") {
    try {
      return await fs.promises.readFile(uri.fsPath, "utf8");
    } catch {
      return "";
    }
  }
  const provider = registry.contentProviders.get(uri.scheme);
  if (!provider) {
    console.warn(`[shim] vscode.diff: no provider for scheme "${uri.scheme}"`);
    return "";
  }
  const result = await Promise.resolve(provider.provideTextDocumentContent(uri));
  return typeof result === "string" ? result : "";
}

function originalFsPath(uri: Uri): string {
  // For graphite-diff:// URIs the query carries side + comparison info and the
  // file:// fsPath is reachable via uri.with({scheme:"file", query:""}). For
  // file:// just use fsPath directly.
  if (uri.scheme === "file") return uri.fsPath;
  try {
    return uri.with({ scheme: "file", query: "" }).fsPath;
  } catch {
    return uri.path;
  }
}

registry.commands.set("vscode.diff", async (...args: unknown[]): Promise<void> => {
  const left = args[0];
  const right = args[1];
  const title = typeof args[2] === "string" ? (args[2] as string) : "Diff";
  if (!(left instanceof Uri) || !(right instanceof Uri)) {
    console.warn("[shim] vscode.diff: expected Uri arguments");
    return;
  }
  const [leftContents, rightContents] = await Promise.all([readUri(left), readUri(right)]);
  const leftPath = originalFsPath(left);
  const rightPath = originalFsPath(right);
  enqueueDiff({
    title,
    leftName: path.basename(leftPath) || "left",
    leftContents,
    rightName: path.basename(rightPath) || "right",
    rightContents,
  });
});

// ComparisonType is referenced through `vscode.ComparisonType.*` in some
// bundled dependencies — keep this map populated so reads don't blow up.
const ComparisonType = {
  UncommittedChanges: "UNCOMMITTED",
  HeadChanges: "HEAD",
  StackChanges: "STACK",
  Committed: "COMMITTED",
  Commit: "COMMIT",
  Range: "RANGE",
} as const;

const vscode = {
  Disposable: DisposableImpl,
  Uri,
  Range,
  Selection,
  RelativePattern,
  ViewColumn,
  ConfigurationTarget,
  TextEditorRevealType,
  ComparisonType,
  commands,
  window,
  workspace,
  env,
  version: "1.95.0",
  __registry: registry,
};

export { Uri, WebviewPanelLike };
export default vscode;
module.exports = vscode;
module.exports.default = vscode;
