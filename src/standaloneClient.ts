// Client-side script served at /standalone/client.js. Bundled as a string so
// we can ship a single dist/server.js without juggling static asset paths.
//
// What it does, all from inside the browser tab:
//   1. Listens via SSE for "an Open file click happened but no editor is
//      configured" events from the host, and shows a modal.
//   2. Watches the DOM for GTI's settings popover (.settings-dropdown) and
//      injects an "Editor (standalone)" section into it so the user can
//      change editor later.
//   3. Talks to the host's /standalone/editor-config endpoints to read
//      detection state and persist the chosen editor.
//   4. Renders VSCode-style notifications (toasts + modal dialogs) that the
//      shim enqueues from showInformation/Warning/ErrorMessage. Button
//      clicks POST back to /standalone/notifications/respond so the
//      extension's awaiting promise resolves with the chosen item.
//
// Notes on robustness: the DOM-injection (#2) targets a class name that's
// part of the vendored GTI bundle. If a future GRAPHITE_VERSION renames it,
// the rest of the app keeps working — only the inline re-config affordance
// disappears, and the modal still pops on first open as a fallback.

const BACKTICK = "`";

export const STANDALONE_CLIENT_JS = String.raw`(() => {
  "use strict";

  // ---- styles -------------------------------------------------------------

  const CSS = ${BACKTICK}
.gh-modal-backdrop {
  position: fixed; inset: 0; z-index: 100000;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--body-font, sans-serif);
  color: var(--vscode-foreground, #ccc);
}
.gh-modal {
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  border-radius: 4px;
  width: min(560px, 92vw);
  max-height: 90vh;
  display: flex; flex-direction: column;
  padding: 20px 22px;
  gap: 14px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
}
.gh-modal h2 {
  margin: 0; font-size: 16px; font-weight: 600;
}
.gh-modal .gh-modal-sub {
  font-size: 12px; color: var(--vscode-descriptionForeground, #cccccc99);
  margin-top: -6px;
}
.gh-modal .gh-pending {
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--panel-view-border, rgba(128,128,128,0.35));
  border-radius: 3px;
  padding: 8px 10px;
  font-size: 12px;
  word-break: break-all;
}
.gh-modal .gh-pending code { font-family: ui-monospace, monospace; }
.gh-options {
  display: flex; flex-direction: column; gap: 4px;
  overflow-y: auto;
  max-height: 45vh;
  padding: 2px;
}
.gh-option {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px;
  border-radius: 3px;
  cursor: pointer;
  border: 1px solid transparent;
}
.gh-option:hover { background: rgba(255,255,255,0.04); }
.gh-option input[type="radio"] { margin: 0; }
.gh-option .gh-option-name { flex: 1; }
.gh-option .gh-option-hint {
  font-size: 11px; color: var(--vscode-descriptionForeground, #cccccc99);
}
.gh-option.gh-not-detected .gh-option-name { color: var(--vscode-descriptionForeground, #cccccc99); }
.gh-option.gh-selected {
  background: var(--list-active-selection-background, #04395e);
  color: var(--list-active-selection-foreground, #fff);
}
.gh-option.gh-selected .gh-option-hint { color: inherit; opacity: 0.8; }
.gh-custom-cmd {
  display: flex; flex-direction: column; gap: 6px;
  margin: 4px 0 0 28px;
}
.gh-custom-cmd input {
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-foreground, #ccc);
  border: 1px solid var(--dropdown-border, #3c3c3c);
  border-radius: 2px;
  padding: 6px 8px;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.gh-custom-cmd input:focus {
  outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px;
}
.gh-custom-cmd .gh-hint {
  font-size: 11px; color: var(--vscode-descriptionForeground, #cccccc99);
}
.gh-buttons {
  display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px;
}
.gh-btn {
  padding: 6px 14px;
  border-radius: 2px;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
}
.gh-btn-primary {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
}
.gh-btn-primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.gh-btn-secondary {
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #fff);
}
.gh-btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }

.gh-settings-section {
  display: flex; flex-direction: column; gap: 6px;
  padding-top: var(--halfpad, 4px);
}
.gh-settings-row {
  display: flex; align-items: center; gap: 10px; justify-content: space-between;
}
.gh-settings-row .gh-current {
  font-size: 12px; color: var(--vscode-descriptionForeground, #cccccc99);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gh-settings-input {
  min-width: 0; flex: 1;
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-foreground, #ccc);
  border: 1px solid var(--dropdown-border, #3c3c3c);
  border-radius: 2px;
  padding: 4px 6px;
  font-size: 12px;
}

.gh-toast-stack {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 99999;
  display: flex;
  flex-direction: column-reverse;
  gap: 10px;
  max-width: min(420px, calc(100vw - 40px));
  pointer-events: none;
  font-family: var(--body-font, sans-serif);
  color: var(--vscode-foreground, #ccc);
}
.gh-toast {
  pointer-events: auto;
  background: var(--vscode-notifications-background, var(--vscode-editorWidget-background, #252526));
  color: var(--vscode-notifications-foreground, var(--vscode-foreground, #ccc));
  border: 1px solid var(--vscode-notifications-border, var(--vscode-editorWidget-border, #454545));
  border-left: 3px solid var(--gh-toast-accent, var(--vscode-focusBorder, #007fd4));
  border-radius: 3px;
  padding: 10px 12px 10px 14px;
  font-size: 12px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.gh-toast-info { --gh-toast-accent: var(--vscode-notificationsInfoIcon-foreground, #3794ff); }
.gh-toast-warn { --gh-toast-accent: var(--vscode-notificationsWarningIcon-foreground, #cca700); }
.gh-toast-error { --gh-toast-accent: var(--vscode-notificationsErrorIcon-foreground, #f48771); }
.gh-toast-head {
  display: flex; align-items: flex-start; gap: 8px;
}
.gh-toast-icon {
  flex: 0 0 auto;
  width: 14px; height: 14px;
  color: var(--gh-toast-accent);
  margin-top: 1px;
}
.gh-toast-body { flex: 1; min-width: 0; }
.gh-toast-message { white-space: pre-wrap; word-break: break-word; }
.gh-toast-detail {
  margin-top: 4px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #cccccc99);
  white-space: pre-wrap; word-break: break-word;
}
.gh-toast-close {
  flex: 0 0 auto;
  background: transparent;
  border: none;
  color: var(--vscode-foreground, #ccc);
  opacity: 0.6;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}
.gh-toast-close:hover { opacity: 1; }
.gh-toast-actions {
  display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap;
}
.gh-toast-actions .gh-btn {
  padding: 4px 10px;
  font-size: 12px;
}
${BACKTICK};

  function ensureStyle() {
    if (document.getElementById("gh-standalone-styles")) return;
    const s = document.createElement("style");
    s.id = "gh-standalone-styles";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---- API helpers --------------------------------------------------------

  async function fetchConfig() {
    const r = await fetch("/standalone/editor-config");
    if (!r.ok) throw new Error("config fetch failed: " + r.status);
    return r.json();
  }

  async function saveConfig(editor) {
    const r = await fetch("/standalone/editor-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editor }),
    });
    if (!r.ok) throw new Error("save failed: " + r.status);
    return r.json();
  }

  async function saveStandaloneConfig(patch) {
    const r = await fetch("/standalone/editor-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error("save failed: " + r.status);
    return r.json();
  }

  async function cancelPending() {
    await fetch("/standalone/editor-config/cancel", { method: "POST" });
  }

  // ---- modal --------------------------------------------------------------

  let modalEl = null;
  let modalOpen = false;
  const DEFAULT_CUSTOM = "code --goto {file}:{line}:{col}";

  function buildModal(state, pending) {
    ensureStyle();
    const backdrop = document.createElement("div");
    backdrop.className = "gh-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "gh-modal";
    backdrop.appendChild(modal);

    const title = document.createElement("h2");
    title.textContent = pending ? "Pick an editor to open this file" : "Pick an editor";
    modal.appendChild(title);

    const sub = document.createElement("div");
    sub.className = "gh-modal-sub";
    sub.textContent = pending
      ? "First time opening a file from Graphite GUI standalone. Your choice is remembered."
      : "Used for the 'Open file' action in Graphite GUI standalone.";
    modal.appendChild(sub);

    if (pending) {
      const p = document.createElement("div");
      p.className = "gh-pending";
      const code = document.createElement("code");
      code.textContent = pending.line ? pending.file + ":" + pending.line : pending.file;
      p.appendChild(code);
      modal.appendChild(p);
    }

    const options = document.createElement("div");
    options.className = "gh-options";
    modal.appendChild(options);

    const firstDetected = state.presets.find((p) => state.detected[p.id]);
    const editor = state.editor;
    const initialKind = editor?.kind ?? (firstDetected ? "preset" : "os-default");
    const initialPreset = editor?.kind === "preset"
      ? editor.preset
      : (firstDetected?.id ?? state.presets[0].id);
    const initialCommand = editor?.kind === "command" ? editor.command : DEFAULT_CUSTOM;

    const radios = [];
    let customInput = null;

    function row(value, name, hint, opts) {
      const label = document.createElement("label");
      label.className = "gh-option";
      if (opts && opts.notDetected) label.classList.add("gh-not-detected");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "gh-editor";
      radio.value = value;
      label.appendChild(radio);
      const nameEl = document.createElement("span");
      nameEl.className = "gh-option-name";
      nameEl.textContent = name;
      label.appendChild(nameEl);
      if (hint) {
        const h = document.createElement("span");
        h.className = "gh-option-hint";
        h.textContent = hint;
        label.appendChild(h);
      }
      options.appendChild(label);
      radios.push({ value, radio, row: label });
      return radio;
    }

    for (const p of state.presets) {
      const detected = state.detected[p.id];
      row("preset:" + p.id, p.name, detected ? "" : "(not found on PATH)", { notDetected: !detected });
    }
    row("command", "Custom command…", "", {});
    row("os-default", "OS default (current behavior)", "open / xdg-open / start", {});

    // Custom command sub-input
    const customWrap = document.createElement("div");
    customWrap.className = "gh-custom-cmd";
    customWrap.style.display = "none";
    customInput = document.createElement("input");
    customInput.type = "text";
    customInput.value = initialCommand;
    customInput.placeholder = DEFAULT_CUSTOM;
    customWrap.appendChild(customInput);
    const hint = document.createElement("div");
    hint.className = "gh-hint";
    hint.textContent = "Placeholders: {file}, {line}, {col}. Runs via your shell.";
    customWrap.appendChild(hint);
    // Insert directly after the "command" radio row.
    const cmdRow = radios.find((r) => r.value === "command");
    cmdRow.row.after(customWrap);

    function applySelection() {
      const selected = radios.find((r) => r.radio.checked);
      for (const r of radios) r.row.classList.toggle("gh-selected", r.radio.checked);
      customWrap.style.display = selected && selected.value === "command" ? "flex" : "none";
    }

    for (const r of radios) r.radio.addEventListener("change", applySelection);

    // Apply initial state
    const initialValue =
      initialKind === "preset" ? "preset:" + initialPreset :
      initialKind === "command" ? "command" : "os-default";
    const initial = radios.find((r) => r.value === initialValue);
    if (initial) initial.radio.checked = true;
    applySelection();

    // Buttons
    const buttons = document.createElement("div");
    buttons.className = "gh-buttons";
    modal.appendChild(buttons);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "gh-btn gh-btn-secondary";
    cancelBtn.textContent = "Cancel";
    buttons.appendChild(cancelBtn);

    const saveBtn = document.createElement("button");
    saveBtn.className = "gh-btn gh-btn-primary";
    saveBtn.textContent = pending ? "Save and open" : "Save";
    buttons.appendChild(saveBtn);

    cancelBtn.addEventListener("click", async () => {
      if (pending) await cancelPending();
      closeModal();
    });

    saveBtn.addEventListener("click", async () => {
      const selected = radios.find((r) => r.radio.checked);
      if (!selected) return;
      let editor;
      if (selected.value === "command") {
        const cmd = (customInput.value || "").trim();
        if (!cmd) { customInput.focus(); return; }
        editor = { kind: "command", command: cmd };
      } else if (selected.value === "os-default") {
        editor = { kind: "os-default" };
      } else {
        editor = { kind: "preset", preset: selected.value.slice("preset:".length) };
      }
      saveBtn.disabled = true;
      try {
        await saveConfig(editor);
      } catch (e) {
        console.error("[gh] save failed:", e);
        saveBtn.disabled = false;
        return;
      }
      closeModal();
      refreshSettingsRow();
    });

    return backdrop;
  }

  async function openModal(showPending) {
    if (modalOpen) return;
    modalOpen = true;
    let state;
    try {
      state = await fetchConfig();
    } catch (e) {
      console.error("[gh] could not load editor config:", e);
      modalOpen = false;
      return;
    }
    modalEl = buildModal(state, showPending ? state.pending : null);
    document.body.appendChild(modalEl);
  }

  function closeModal() {
    if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
    modalEl = null;
    modalOpen = false;
  }

  // ---- notifications ------------------------------------------------------

  const seenNotifications = new Set();
  let toastStackEl = null;

  function ensureToastStack() {
    if (toastStackEl && toastStackEl.isConnected) return toastStackEl;
    toastStackEl = document.createElement("div");
    toastStackEl.className = "gh-toast-stack";
    document.body.appendChild(toastStackEl);
    return toastStackEl;
  }

  async function respondNotification(id, title) {
    try {
      await fetch("/standalone/notifications/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(title === undefined ? { id } : { id, title }),
      });
    } catch (e) {
      console.error("[gh] respond failed:", e);
    }
  }

  function severityLabel(sev) {
    return sev === "warn" ? "Warning" : sev === "error" ? "Error" : "Info";
  }

  function showToast(n) {
    ensureStyle();
    const stack = ensureToastStack();
    const toast = document.createElement("div");
    toast.className = "gh-toast gh-toast-" + n.severity;

    const head = document.createElement("div");
    head.className = "gh-toast-head";

    const body = document.createElement("div");
    body.className = "gh-toast-body";
    const msg = document.createElement("div");
    msg.className = "gh-toast-message";
    msg.textContent = n.message;
    body.appendChild(msg);
    if (n.detail) {
      const d = document.createElement("div");
      d.className = "gh-toast-detail";
      d.textContent = n.detail;
      body.appendChild(d);
    }
    head.appendChild(body);

    const close = document.createElement("button");
    close.className = "gh-toast-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    head.appendChild(close);
    toast.appendChild(head);

    let timer = null;
    function dismiss(title) {
      if (!toast.isConnected) return;
      if (timer != null) clearTimeout(timer);
      toast.remove();
      respondNotification(n.id, title);
    }
    close.addEventListener("click", () => dismiss(undefined));

    if (n.items.length > 0) {
      const actions = document.createElement("div");
      actions.className = "gh-toast-actions";
      n.items.forEach((it, i) => {
        const btn = document.createElement("button");
        btn.className = "gh-btn " + (i === n.items.length - 1 ? "gh-btn-primary" : "gh-btn-secondary");
        btn.textContent = it.title;
        btn.addEventListener("click", () => dismiss(it.title));
        actions.appendChild(btn);
      });
      toast.appendChild(actions);
    } else {
      // VSCode auto-hides info/warning toasts after a few seconds when
      // there's nothing actionable. Error toasts stick until dismissed.
      if (n.severity !== "error") {
        timer = setTimeout(() => dismiss(undefined), 8000);
      }
    }

    stack.appendChild(toast);
  }

  function showNotificationModal(n) {
    ensureStyle();
    const backdrop = document.createElement("div");
    backdrop.className = "gh-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "gh-modal";
    backdrop.appendChild(modal);

    const title = document.createElement("h2");
    title.textContent = severityLabel(n.severity);
    modal.appendChild(title);

    const body = document.createElement("div");
    body.className = "gh-toast-message";
    body.textContent = n.message;
    modal.appendChild(body);

    if (n.detail) {
      const d = document.createElement("div");
      d.className = "gh-modal-sub";
      d.style.marginTop = "0";
      d.style.whiteSpace = "pre-wrap";
      d.textContent = n.detail;
      modal.appendChild(d);
    }

    const buttons = document.createElement("div");
    buttons.className = "gh-buttons";
    modal.appendChild(buttons);

    function respond(title) {
      if (!backdrop.isConnected) return;
      backdrop.remove();
      respondNotification(n.id, title);
    }

    if (n.items.length === 0) {
      const ok = document.createElement("button");
      ok.className = "gh-btn gh-btn-primary";
      ok.textContent = "OK";
      ok.addEventListener("click", () => respond(undefined));
      buttons.appendChild(ok);
    } else {
      const cancel = document.createElement("button");
      cancel.className = "gh-btn gh-btn-secondary";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => respond(undefined));
      buttons.appendChild(cancel);
      n.items.forEach((it, i) => {
        const btn = document.createElement("button");
        const primary = i === n.items.length - 1;
        btn.className = "gh-btn " + (primary ? "gh-btn-primary" : "gh-btn-secondary");
        btn.textContent = it.title;
        btn.addEventListener("click", () => respond(it.title));
        buttons.appendChild(btn);
      });
    }

    document.body.appendChild(backdrop);
  }

  function handleNotification(n) {
    if (!n || typeof n.id !== "string") return;
    if (seenNotifications.has(n.id)) return;
    seenNotifications.add(n.id);
    if (n.modal) showNotificationModal(n);
    else showToast(n);
  }

  // ---- diff panel ---------------------------------------------------------
  // The diff renderer is heavy (~10MB with shiki); load on first use.

  let diffPanelLoading = null;
  function loadDiffPanel() {
    if (window.__ghDiffPanel) return Promise.resolve(window.__ghDiffPanel);
    if (diffPanelLoading) return diffPanelLoading;
    diffPanelLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/standalone/diff-panel.js";
      s.async = true;
      s.onload = () => {
        if (window.__ghDiffPanel) resolve(window.__ghDiffPanel);
        else reject(new Error("diff-panel.js loaded but __ghDiffPanel missing"));
      };
      s.onerror = () => reject(new Error("failed to load diff-panel.js"));
      document.head.appendChild(s);
    });
    return diffPanelLoading;
  }

  async function handleDiff(payload) {
    if (!payload || typeof payload.id !== "string") return;
    try {
      const api = await loadDiffPanel();
      api.open(payload);
    } catch (e) {
      console.error("[gh] could not open diff panel:", e);
    }
  }

  function init() {
    ensureStyle();
    startObserver();
    const es = new EventSource("/standalone/events");
    es.addEventListener("pendingOpen", () => openModal(true));
    es.addEventListener("notification", (ev) => {
      try {
        handleNotification(JSON.parse(ev.data));
      } catch (e) {
        console.error("[gh] bad notification payload:", e);
      }
    });
    es.addEventListener("diff", (ev) => {
      try {
        handleDiff(JSON.parse(ev.data));
      } catch (e) {
        console.error("[gh] bad diff payload:", e);
      }
    });
    fetchConfig().then((state) => {
      if (state.pending) openModal(true);
    }).catch(() => {});
  }

  function describeChoice(state) {
    if (!state.editor) return "Not set (will prompt)";
    if (state.editor.kind === "preset") {
      const p = state.presets.find((x) => x.id === state.editor.preset);
      return p ? p.name : state.editor.preset;
    }
    if (state.editor.kind === "command") return state.editor.command;
    return "OS default";
  }

  async function refreshSettingsRow() {
    const row = document.getElementById("gh-current-editor");
    if (!row) return;
    try {
      const state = await fetchConfig();
      row.textContent = describeChoice(state);
    } catch {
      // ignore — the row will refresh next time the popover opens
    }
  }

  async function injectInto(dropdown) {
    removeVSCodeOnlySettings(dropdown);
    if (dropdown.querySelector(".gh-settings-section")) return;

    let state;
    try {
      state = await fetchConfig();
    } catch (e) {
      console.error("[gh] could not load editor config:", e);
      return;
    }

    const hr = document.createElement("hr");
    hr.className = "setting-hr";

    const section = document.createElement("div");
    section.className = "gh-settings-section";

    const title = document.createElement("div");
    title.className = "setting-subtitle";
    title.textContent = "Standalone";
    section.appendChild(title);

    const desc = document.createElement("div");
    desc.className = "setting-description";
    desc.textContent = "Local integration settings for this standalone app.";
    section.appendChild(desc);

    const cliRow = document.createElement("div");
    cliRow.className = "gh-settings-row";

    const cliInput = document.createElement("input");
    cliInput.className = "gh-settings-input";
    cliInput.type = "text";
    cliInput.value = state.vscodeConfig?.["graphite.commandPath"] || "";
    cliInput.placeholder = "gt";
    cliInput.title = "Graphite command path. Blank uses gt on PATH. Reload required.";
    cliRow.appendChild(cliInput);

    const cliBtn = document.createElement("button");
    cliBtn.className = "gh-btn gh-btn-secondary";
    cliBtn.style.padding = "4px 10px";
    cliBtn.style.fontSize = "12px";
    cliBtn.textContent = "Save CLI";
    cliBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      cliBtn.disabled = true;
      try {
        await saveStandaloneConfig({
          vscodeConfig: { "graphite.commandPath": cliInput.value.trim() },
        });
        cliBtn.textContent = "Saved";
        setTimeout(() => { cliBtn.textContent = "Save CLI"; }, 1200);
      } catch (err) {
        console.error("[gh] save failed:", err);
      } finally {
        cliBtn.disabled = false;
      }
    });
    cliRow.appendChild(cliBtn);
    section.appendChild(cliRow);

    const cliHint = document.createElement("div");
    cliHint.className = "setting-description";
    cliHint.textContent = "Graphite CLI command. Blank uses gt on PATH; reload required.";
    section.appendChild(cliHint);

    const editorDesc = document.createElement("div");
    editorDesc.className = "setting-description";
    editorDesc.textContent = "Editor used when Graphite asks to open a file.";
    section.appendChild(editorDesc);

    const row = document.createElement("div");
    row.className = "gh-settings-row";

    const current = document.createElement("div");
    current.className = "gh-current";
    current.id = "gh-current-editor";
    current.textContent = describeChoice(state);
    row.appendChild(current);

    const btn = document.createElement("button");
    btn.className = "gh-btn gh-btn-secondary";
    btn.style.padding = "4px 10px";
    btn.style.fontSize = "12px";
    btn.textContent = "Change…";
    btn.addEventListener("click", (e) => {
      // Close the settings popover before opening the modal. Otherwise the
      // popover sits behind us and treats the first modal click as an
      // outside-click, slamming itself shut mid-interaction. Clicking the
      // gear toggles the popover closed in one shot.
      e.stopPropagation();
      const gear = document.querySelector('[data-testid="settings-gear-button"]');
      if (gear instanceof HTMLElement) gear.click();
      openModal(false);
    });
    row.appendChild(btn);

    section.appendChild(row);

    dropdown.appendChild(hr);
    dropdown.appendChild(section);
  }

  function removeVSCodeOnlySettings(dropdown) {
    for (const child of Array.from(dropdown.children)) {
      if (child.classList && child.classList.contains("gh-settings-section")) continue;
      const text = (child.textContent || "").toLowerCase();
      if (text.includes("show in sidebar") || text.includes("show graphite interactive in the sidebar")) {
        child.remove();
      }
    }
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.classList && node.classList.contains("settings-dropdown")) {
            injectInto(node);
          } else {
            const found = node.querySelector && node.querySelector(".settings-dropdown");
            if (found) injectInto(found);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
`;
