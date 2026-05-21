// Bundled by esbuild → dist/diff-panel.js (IIFE, browser).
//
// Loaded lazily by src/standaloneClient.ts the first time the host signals a
// diff request. We render the diff with @pierre/diffs inside a resizable
// right-hand-side panel; the host pushes payloads in via window.__ghDiffPanel.
//
// The shim/host side lives in src/diffRequests.ts and src/vscodeShim.ts
// (vscode.diff handler).

import { FileDiff } from "@pierre/diffs";

interface DiffPayload {
  id: string;
  title: string;
  leftName: string;
  leftContents: string;
  rightName: string;
  rightContents: string;
}

const STORAGE_KEY = "gh-diff-panel-width";
const DEFAULT_WIDTH = 720;
const MIN_WIDTH = 360;

const CSS = `
.gh-diff-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 90000;
  display: flex;
  flex-direction: column;
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-foreground, #ccc);
  border-left: 1px solid var(--vscode-editorWidget-border, #454545);
  box-shadow: -4px 0 12px rgba(0, 0, 0, 0.25);
  font-family: var(--body-font, sans-serif);
}
.gh-diff-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
  background: var(--vscode-editorWidget-background, #252526);
  flex: 0 0 auto;
}
.gh-diff-panel-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gh-diff-panel-close {
  background: transparent;
  border: none;
  color: var(--vscode-foreground, #ccc);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 2px 6px;
  opacity: 0.7;
}
.gh-diff-panel-close:hover {
  opacity: 1;
}
.gh-diff-panel-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.gh-diff-panel-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  width: 6px;
  cursor: col-resize;
  z-index: 1;
}
.gh-diff-panel-resizer:hover,
.gh-diff-panel-resizer.gh-dragging {
  background: var(--vscode-focusBorder, #007fd4);
  opacity: 0.4;
}
`;

let styleEl: HTMLStyleElement | null = null;
let panelEl: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let titleEl: HTMLDivElement | null = null;
let currentInstance: FileDiff | null = null;

function ensureStyle(): void {
  if (styleEl && styleEl.isConnected) return;
  styleEl = document.createElement("style");
  styleEl.id = "gh-diff-panel-styles";
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
}

function clampWidth(w: number): number {
  const max = Math.max(MIN_WIDTH, window.innerWidth - 200);
  return Math.max(MIN_WIDTH, Math.min(w, max));
}

function readStoredWidth(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY) ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WIDTH;
  return clampWidth(raw);
}

function setWidth(w: number): void {
  if (!panelEl) return;
  const clamped = clampWidth(w);
  panelEl.style.width = clamped + "px";
  localStorage.setItem(STORAGE_KEY, String(clamped));
}

function ensurePanel(): { body: HTMLDivElement; title: HTMLDivElement } {
  ensureStyle();
  if (panelEl && bodyEl && titleEl && panelEl.isConnected) {
    return { body: bodyEl, title: titleEl };
  }

  panelEl = document.createElement("div");
  panelEl.className = "gh-diff-panel";

  const resizer = document.createElement("div");
  resizer.className = "gh-diff-panel-resizer";
  resizer.title = "Drag to resize";
  panelEl.appendChild(resizer);

  const header = document.createElement("div");
  header.className = "gh-diff-panel-header";
  panelEl.appendChild(header);

  titleEl = document.createElement("div");
  titleEl.className = "gh-diff-panel-title";
  header.appendChild(titleEl);

  const close = document.createElement("button");
  close.className = "gh-diff-panel-close";
  close.textContent = "×";
  close.title = "Close diff";
  close.addEventListener("click", closePanel);
  header.appendChild(close);

  bodyEl = document.createElement("div");
  bodyEl.className = "gh-diff-panel-body";
  panelEl.appendChild(bodyEl);

  document.body.appendChild(panelEl);

  // Drag-to-resize
  let dragStartX = 0;
  let dragStartWidth = 0;
  function onMove(e: MouseEvent): void {
    const dx = dragStartX - e.clientX;
    setWidth(dragStartWidth + dx);
  }
  function onUp(): void {
    resizer.classList.remove("gh-dragging");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = "";
  }
  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (!panelEl) return;
    dragStartX = e.clientX;
    dragStartWidth = panelEl.getBoundingClientRect().width;
    resizer.classList.add("gh-dragging");
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  window.addEventListener("resize", () => {
    if (panelEl) setWidth(panelEl.getBoundingClientRect().width);
  });

  setWidth(readStoredWidth());
  return { body: bodyEl, title: titleEl };
}

function closePanel(): void {
  if (currentInstance) {
    try {
      currentInstance.cleanUp();
    } catch {
      // ignore
    }
    currentInstance = null;
  }
  if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
  panelEl = null;
  bodyEl = null;
  titleEl = null;
}

function openDiff(payload: DiffPayload): void {
  const { body, title } = ensurePanel();
  title.textContent = payload.title || `${payload.leftName} ↔ ${payload.rightName}`;
  if (currentInstance) {
    try {
      currentInstance.cleanUp();
    } catch {
      // ignore
    }
    currentInstance = null;
  }
  body.replaceChildren();
  const root = document.createElement("div");
  body.appendChild(root);

  currentInstance = new FileDiff({
    theme: { dark: "pierre-dark", light: "pierre-light" },
  });
  currentInstance.render({
    oldFile: { name: payload.leftName, contents: payload.leftContents },
    newFile: { name: payload.rightName, contents: payload.rightContents },
    containerWrapper: root,
  });
}

// Bridge between standaloneClient (SSE consumer) and this module.
interface DiffPanelAPI {
  open(payload: DiffPayload): void;
  close(): void;
}
declare global {
  interface Window {
    __ghDiffPanel?: DiffPanelAPI;
  }
}
window.__ghDiffPanel = { open: openDiff, close: closePanel };
