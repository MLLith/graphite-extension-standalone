// Diff payloads pushed from the vscode shim when the extension calls
// vscode.diff. The browser tab subscribes via SSE in server.ts and renders the
// payload in a right-hand-side panel (src/diffPanel.ts).

export interface DiffPayload {
  id: string;
  /** Display title from the extension, e.g. "foo.ts (Changes in current commit)". */
  title: string;
  leftName: string;
  leftContents: string;
  rightName: string;
  rightContents: string;
}

const listeners = new Set<(p: DiffPayload) => void>();
let current: DiffPayload | null = null;
let counter = 0;

export function subscribeDiff(l: (p: DiffPayload) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getCurrentDiff(): DiffPayload | null {
  return current;
}

export function enqueueDiff(p: Omit<DiffPayload, "id">): DiffPayload {
  counter += 1;
  current = { ...p, id: String(counter) };
  for (const l of listeners) l(current);
  return current;
}
