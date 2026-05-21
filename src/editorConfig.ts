// "Open file" preference for standalone. In VSCode, showTextDocument opens the
// file in-editor; here we shell out to a user-chosen editor (or prompt once via
// the browser modal + SSE in server.ts).

import path from "path";
import fs from "fs";
import os from "os";
import * as childProcess from "child_process";

export type EditorChoice =
  | { kind: "preset"; preset: string }
  | { kind: "command"; command: string }
  | { kind: "os-default" };

interface ConfigShape {
  editor?: EditorChoice;
  vscodeConfig?: {
    "graphite.commandPath"?: string;
  };
}

export type PersistedVSCodeConfigKey = keyof NonNullable<ConfigShape["vscodeConfig"]>;

export interface PresetDef {
  id: string;
  name: string;
  bin: string;
  argv(file: string, line: number, col: number): string[];
}

export const PRESETS: PresetDef[] = [
  // GUI editors with predictable CLIs. Terminal editors belong in "custom command".
  { id: "cursor", name: "Cursor", bin: "cursor", argv: (f, l, c) => ["--goto", `${f}:${l}:${c}`] },
  {
    id: "vscode",
    name: "Visual Studio Code",
    bin: "code",
    argv: (f, l, c) => ["--goto", `${f}:${l}:${c}`],
  },
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    bin: "code-insiders",
    argv: (f, l, c) => ["--goto", `${f}:${l}:${c}`],
  },
  { id: "sublime", name: "Sublime Text", bin: "subl", argv: (f, l, c) => [`${f}:${l}:${c}`] },
  { id: "zed", name: "Zed", bin: "zed", argv: (f, l, c) => [`${f}:${l}:${c}`] },
  {
    id: "webstorm",
    name: "WebStorm",
    bin: "webstorm",
    argv: (f, l, c) => ["--line", String(l), "--column", String(c), f],
  },
  {
    id: "idea",
    name: "IntelliJ IDEA",
    bin: "idea",
    argv: (f, l, c) => ["--line", String(l), "--column", String(c), f],
  },
];

function configFile(): string {
  const base =
    process.platform === "win32"
      ? path.join(
          process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
          "graphite-extension-standalone",
        )
      : path.join(
          process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
          "graphite-extension-standalone",
        );
  return path.join(base, "config.json");
}

let cached: ConfigShape | null = null;

function loadConfig(): ConfigShape {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(configFile(), "utf8")) as ConfigShape;
  } catch {
    cached = {};
  }
  return cached;
}

function writeConfig(cfg: ConfigShape): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  cached = cfg;
}

export function getEditorChoice(): EditorChoice | undefined {
  return loadConfig().editor;
}

export function getPersistedVSCodeConfig(): Record<PersistedVSCodeConfigKey, unknown> {
  return {
    "graphite.commandPath": loadConfig().vscodeConfig?.["graphite.commandPath"] ?? "",
  };
}

export function persistVSCodeConfig(key: string, value: unknown): boolean {
  if (key !== "graphite.commandPath") return false;
  const cfg = loadConfig();
  cfg.vscodeConfig ??= {};
  cfg.vscodeConfig[key] = typeof value === "string" ? value : "";
  writeConfig(cfg);
  return true;
}

export function detectPresets(): Record<string, boolean> {
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const out: Record<string, boolean> = {};
  for (const p of PRESETS) {
    let found = false;
    for (const dir of PATH.split(sep)) {
      if (!dir) continue;
      for (const ext of exts) {
        try {
          fs.accessSync(path.join(dir, p.bin + ext), fs.constants.X_OK);
          found = true;
          break;
        } catch {
          // try next
        }
      }
      if (found) break;
    }
    out[p.id] = found;
  }
  return out;
}

export function parseEditorChoice(raw: unknown): EditorChoice | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as EditorChoice;
  if (e.kind === "preset" && typeof e.preset === "string") return e;
  if (e.kind === "command" && typeof e.command === "string") return e;
  if (e.kind === "os-default") return e;
  return null;
}

function openFileWith(editor: EditorChoice, file: string, line?: number): void {
  const l = Math.max(1, line ?? 1);
  const c = 1;
  if (editor.kind === "preset") {
    const preset = PRESETS.find((p) => p.id === editor.preset);
    if (!preset) {
      console.warn(`[editor] unknown preset "${editor.preset}"`);
      return;
    }
    childProcess
      .spawn(preset.bin, preset.argv(file, l, c), { detached: true, stdio: "ignore" })
      .unref();
    return;
  }
  if (editor.kind === "command") {
    const cmd = editor.command
      .replace(/\{file\}/g, file)
      .replace(/\{line\}/g, String(l))
      .replace(/\{col\}/g, String(c));
    childProcess.spawn(cmd, { shell: true, detached: true, stdio: "ignore" }).unref();
    return;
  }
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  childProcess.spawn(opener, [file], { detached: true, stdio: "ignore" }).unref();
}

export interface PendingOpen {
  file: string;
  line?: number;
}

let pending: PendingOpen | null = null;
const listeners = new Set<() => void>(); // SSE subscribers in server.ts

export function getPending(): PendingOpen | null {
  return pending;
}

export function clearPending(): void {
  pending = null;
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function requestOpen(file: string, line?: number): void {
  // Called from vscodeShim.showTextDocument.
  const editor = getEditorChoice();
  if (editor) {
    openFileWith(editor, file, line);
    return;
  }
  pending = { file, line };
  for (const l of listeners) l();
}

export function applyEditorChoice(editor: EditorChoice): { openedPending: boolean } {
  const cfg = loadConfig();
  cfg.editor = editor;
  writeConfig(cfg);

  if (!pending) return { openedPending: false };
  openFileWith(editor, pending.file, pending.line);
  pending = null;
  return { openedPending: true };
}
