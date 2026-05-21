// VSCode-style notifications for standalone. The shim's showInformation/
// Warning/ErrorMessage methods enqueue here; server.ts pushes events over SSE
// and accepts responses via POST. Pending entries stay registered until the
// browser responds (button click or dismissal), so a tab refresh can replay
// any still-open modals.

import { randomUUID } from "crypto";

export type Severity = "info" | "warn" | "error";

export interface NotificationItem {
  title: string;
  isCloseAffordance?: boolean;
}

export interface Notification {
  id: string;
  severity: Severity;
  message: string;
  detail?: string;
  modal: boolean;
  items: NotificationItem[];
}

interface Pending extends Notification {
  resolve: (title: string | undefined) => void;
}

const active = new Map<string, Pending>();
const listeners = new Set<(n: Notification) => void>();

function strip(p: Pending): Notification {
  const { resolve: _r, ...rest } = p;
  return rest;
}

export function subscribeNotifications(l: (n: Notification) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function listActiveNotifications(): Notification[] {
  return Array.from(active.values()).map(strip);
}

export function respondNotification(id: string, title: string | undefined): boolean {
  const n = active.get(id);
  if (!n) return false;
  active.delete(id);
  n.resolve(title);
  return true;
}

export function enqueueNotification(
  severity: Severity,
  message: string,
  detail: string | undefined,
  modal: boolean,
  items: NotificationItem[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const id = randomUUID();
    const entry: Pending = { id, severity, message, detail, modal, items, resolve };
    active.set(id, entry);
    const event = strip(entry);
    for (const l of listeners) l(event);
  });
}
