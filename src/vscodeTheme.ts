// Minimal stand-in for the CSS custom properties VSCode normally injects into
// a webview iframe. The Graphite webview bundle uses `var(--button-secondary-…)`
// etc. throughout; without these declarations the components fall back to
// inherited values (e.g. body color) and produce visual glitches like the
// chevron <select> next to the Sync button leaking its option text.
//
// Values are VSCode Dark+ defaults. If we ever need to follow the user's OS
// preference for dark vs light, swap this for two blocks gated by
// `@media (prefers-color-scheme: light)`.

export const VSCODE_THEME_CSS = `:root {
  /* — Editor / global — */
  --background: #1e1e1e;
  --foreground: #cccccc;
  --vscode-editor-background: #1e1e1e;
  --vscode-editor-foreground: #cccccc;
  --vscode-foreground: #cccccc;
  --vscode-disabledForeground: rgba(204, 204, 204, 0.5);
  --vscode-descriptionForeground: #cccccc99;
  --body-font: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI",
               "Helvetica Neue", sans-serif;

  /* — Font metrics. VSCode webviews inherit body{font-size:13px} from
       the host; the bundle's many font-size:90%/100%/125% rules are
       sized against that. Without these, the browser default of 16px takes
       over and everything (file list, status bar, etc.) renders ~23% larger
       than intended. — */
  --vscode-font-family: var(--body-font);
  --vscode-font-size: 13px;
  --vscode-font-weight: normal;

  /* — Focus — */
  --focus-border: #007fd4;
  --vscode-focusBorder: #007fd4;

  /* — Buttons (unprefixed names used by Graphite's own styles) — */
  --button-secondary-background: #3a3d41;
  --button-secondary-foreground: #ffffff;
  --button-secondary-hover-background: #45494e;
  --button-primary-hover-background: #1177bb;
  --button-icon-hover-background: rgba(90, 93, 94, 0.31);

  /* — Buttons (prefixed names used by @vscode/webview-ui-toolkit internals) — */
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-button-secondaryBackground: #3a3d41;
  --vscode-button-secondaryForeground: #ffffff;
  --vscode-button-secondaryHoverBackground: #45494e;

  /* — Divider / dropdown / tooltip chrome — */
  --divider-background: rgba(204, 204, 204, 0.2);
  --dropdown-border: #3c3c3c;
  --tooltip-background: #252526;
  --tooltip-border: #454545;
  --panel-view-border: rgba(128, 128, 128, 0.35);

  /* — Badge — */
  --badge-background: #4d4d4d;
  --badge-foreground: #ffffff;
  --badge-color-: #cccccc;
  --badge-fill-: #4d4d4d;

  /* — List selection — */
  --list-active-selection-background: #04395e;
  --list-active-selection-foreground: #ffffff;

  /* — Diagnostics — */
  --error-bg-color: rgba(244, 135, 113, 0.15);
  --error-fg-color: #f48771;
  --warning-bg-color: rgba(255, 204, 102, 0.15);
  --warning-fg-color: #ffcc66;

  /* — GitHub PR status — */
  --github-open-bg: #2ea043;
  --github-merged-bg: #8250df;
  --github-closed-bg: #da3633;
  --github-neutral-bg: #6e7681;

  /* — Source-control file change indicators — */
  --scm-added-foreground: #587c0c;
  --scm-modified-foreground: #1b81a8;
  --scm-removed-foreground: #94151b;

  /* — Other VSCode-prefixed chrome — */
  --vscode-editorWidget-background: #252526;
  --vscode-editorWidget-border: #454545;
  --vscode-panel-border: rgba(128, 128, 128, 0.35);
  --vscode-sash-hoverBorder: #007fd4;
  --vscode-sideBar-background: #252526;
  --vscode-sideBarSectionHeader-border: rgba(204, 204, 204, 0.2);

  /* — Graphite-custom layout tokens (mostly already defined inline by the
     bundle; provide fallbacks in case that changes) — */
  --hover-darken: 0.07;
  --arrow-half-width: 4px;
  --arrow-height: 8px;
  --useModalWidth: 600px;
}

/* VSCode's webview iframe always ships with body{margin:0} and a base
 * font-size/family. The bundle's .gti-root is sized at exactly 100vh and
 * assumes the body has no margin (otherwise the bottom 8px containing the
 * progress bar falls off-viewport); the bundle's many font-size:90%/100%
 * rules assume a 13px base (otherwise everything renders ~23% too big). */
body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  font-weight: var(--vscode-font-weight);
}

/* The split-button dropdown next to e.g. "Sync" is a 24px-wide native <select>
 * with appearance:none and a chevron background-image. In VSCode's Electron
 * webview the selected option's label isn't rendered for such selects, but in
 * vanilla Chromium/Safari/Firefox it is, getting clipped to the first ~two
 * characters ("Sy" from "Sync"). The bundle's own CSS doesn't hide it; VSCode
 * relied on a UA quirk.
 *
 * The bundle's CSS-in-JS is injected into <head> at runtime, AFTER this static
 * <style> block, so equal-specificity overrides on 'color' lose the cascade
 * fight. We instead zero out font-size, which the bundle never sets — so we
 * add to the cascade instead of fighting it. Height is explicit (26px) and
 * the chevron icon is a centred background-image, so layout is unaffected. */
.vscode-button-dropdown select {
  font-size: 0;
}
/* Restore a sane font-size on the listbox shown when the dropdown is open;
 * some browsers (Firefox) honour option styling, others ignore it. */
.vscode-button-dropdown select option {
  font-size: 13px;
}
`;
