import type React from "react";
import { create } from "zustand";
import type { FileObj, Message } from "./types";

export type ModalSpec =
  | { kind: "createGuild" }
  | { kind: "joinInvite"; code?: string }
  | { kind: "createChannel"; guildId: string; parentId?: string | null; channelKind?: "text" | "voice" | "category" }
  | { kind: "editChannel"; channelId: string }
  | { kind: "invite"; guildId: string }
  | { kind: "serverSettings"; guildId: string; tab?: string }
  | { kind: "userSettings"; tab?: string }
  | { kind: "confirm"; title: string; body: string; danger?: boolean; confirmLabel?: string; onConfirm: () => void | Promise<void> }
  | { kind: "profile"; userId: string; guildId: string | null }
  | { kind: "screenPicker" }
  | { kind: "saveGif"; fileId?: string; url?: string; preview?: string };

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  render?: () => React.ReactNode;
}

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

interface UI {
  modals: ModalSpec[];
  menu: { x: number; y: number; items: MenuItem[] } | null;
  lightbox: { items: FileObj[]; index: number } | null;
  replyTo: Record<string, Message | undefined>;
  editing: string | null;
  toasts: Toast[];
  collapsed: Record<string, boolean>;
  jumpTo: string | null;
}

export const useUI = create<UI>(() => ({
  modals: [],
  menu: null,
  lightbox: null,
  replyTo: {},
  editing: null,
  toasts: [],
  collapsed: JSON.parse(localStorage.getItem("llamble.collapsed") || "{}"),
  jumpTo: null,
}));

export function openModal(m: ModalSpec) {
  useUI.setState((s) => ({ modals: [...s.modals, m] }));
}
export function closeModal() {
  useUI.setState((s) => ({ modals: s.modals.slice(0, -1) }));
}
export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  e.stopPropagation?.();
  useUI.setState({ menu: { x: e.clientX, y: e.clientY, items } });
}
export function closeMenu() {
  useUI.setState({ menu: null });
}
let toastId = 0;
export function toast(text: string, kind: "info" | "error" = "info") {
  const id = ++toastId;
  useUI.setState((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => useUI.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000);
}
export function setReply(channelId: string, m: Message | undefined) {
  useUI.setState((s) => ({ replyTo: { ...s.replyTo, [channelId]: m } }));
}
export function toggleCollapsed(id: string) {
  useUI.setState((s) => {
    const collapsed = { ...s.collapsed, [id]: !s.collapsed[id] };
    localStorage.setItem("llamble.collapsed", JSON.stringify(collapsed));
    return { collapsed };
  });
}
export function copy(text: string, what = "Copied") {
  navigator.clipboard.writeText(text).then(() => toast(`${what} to clipboard`));
}
