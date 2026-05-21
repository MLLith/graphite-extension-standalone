// Bridges a single browser tab (over a WebSocket) to a synthetic
// WebviewPanel from the vscode shim.

import type { WebSocket } from "ws";
import type { WebviewPanelLike } from "./vscodeShim";

export class WebviewBridge {
  private _ws: WebSocket | null = null;
  private _panel: WebviewPanelLike | null = null;

  attachPanel(panel: WebviewPanelLike): void {
    this._panel = panel;
  }

  // Extension sets webview.html, but the browser loads our static shell at /.
  setHtml(_html: string): void {}

  bindSocket(ws: WebSocket): void {
    this._ws = ws;
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!this._panel) return;
      const payload: unknown = isBinary
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data.toString("utf8"); // gti-server deserializes raw strings itself
      this._panel.webview._messageEmitter.fire(payload);
    });
    ws.on("close", () => {
      if (this._panel) {
        const p = this._panel;
        this._panel = null;
        p.dispose();
      }
      this._ws = null;
    });
  }

  postToClient(message: unknown): Promise<boolean> {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return Promise.resolve(false);
    if (typeof message === "string") ws.send(message);
    else if (message instanceof ArrayBuffer || ArrayBuffer.isView(message))
      ws.send(message as ArrayBuffer | ArrayBufferView);
    else return Promise.resolve(false);
    return Promise.resolve(true);
  }

  focus(): void {}
}
