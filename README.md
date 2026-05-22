# graphite-extension-standalone

**Graphite's stacked-PR vscode/cursor UI, in your browser. No VSCode required.**

_Do yout like the graphical view of your stacks and the click and drag, but don't want to launch a whole dedicated editor for it?_

This project runs the exact same UI as https://graphite.com/docs/vs-code-extension, as a standalone web app, no editor host needed.

## Install

```sh
npm install -g graphite-extension-standalone
```

You need the [`gt`](https://graphite.dev/docs/installing-the-cli) CLI on your
`PATH` (see Environment variables below) and a Graphite-tracked repo.

## Run

```sh
gt-ext-web                       # opens the current directory's repo
gt-ext-web ~/Git/some-repo       # explicit repo
```

A browser tab opens automatically on a free local port. Each launch gets its
own browser origin, so parallel instances stay isolated (separate tabs,
WebSockets, and browser storage).

## How it works (briefly)

The Graphite VSCode extension is mostly a thin shell around two npm packages,
`@withgraphite/gti-server` and `@withgraphite/gti-client`. This project
replaces VSCode with the smallest possible runtime that satisfies the same
contract: a fake `vscode` module, an HTTP server for the webview assets, and
a WebSocket for the gti protocol. The extension JS bundle is loaded and run
unchanged.

---

## Configuration

### Environment variables

| Var                  | Default         | Purpose                                                |
| -------------------- | --------------- | ------------------------------------------------------ |
| `PORT`               | random free     | HTTP + WS port                                         |
| `HOST`               | `127.0.0.1`     | bind address                                           |
| `GRAPHITE_CWD`       | `process.cwd()` | repo root to operate on                                |
| `GRAPHITE_EXT_PATH`  | bundled         | path to a custom extension bundle                      |
| `GRAPHITE_NO_OPEN`   | unset           | don't auto-open a browser tab                          |
| `GRAPHITE_GUI_DEBUG` | unset           | log unimplemented `vscode.commands.executeCommand` ids |

### "Open file" behavior

The first time you click "Open file" in the UI, a modal asks which editor to
launch (Cursor / VS Code / Sublime / Zed / WebStorm / IDEA, a custom command
template, or the OS default). Your choice is stored at:

- `~/.config/graphite-extension-standalone/config.json` (Linux/macOS, XDG)
- `%APPDATA%\graphite-extension-standalone\config.json` (Windows)

You can change it later from the gear-icon settings popover → **Editor
(standalone)** → **Change…**

### Caveats

- **No authentication.** Don't go serving this away from localhost unless you know what you're doing.

### Toolchain (if `npm install` builds from source)

`npm install` will normally fetch a prebuilt `better-sqlite3` matching your
Node ABI. If your platform has no prebuilt available, the build falls back to
compiling from source — that needs Python 3 and a C++ toolchain
(`xcode-select --install` on macOS).

## Develop

```sh
git clone <this-repo>
cd graphite-extension-standalone
npm install        # also fetches the Graphite bundle via postinstall
npm start          # builds + runs
npm run typecheck
```

Set `GRAPHITE_VERSION` to fetch a different version of the upstream
extension; newer versions may need shim updates.

## License

MIT for the host code in this repo. The Graphite GTI bundle downloaded into
`graphite/` is proprietary (see [graphite.dev/legal](https://graphite.dev/legal)).
