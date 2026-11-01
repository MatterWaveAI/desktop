import { useSyncExternalStore } from "react";
import { t } from "@lingui/core/macro";

/**
 * "Your answer is ready", for the person who looked away while it was
 * written. A long completion can stream for minutes; nobody watches a tab
 * that long, and without a signal they come back too early or not at all.
 *
 * Three signals, escalating, each only while the tab is hidden:
 *
 *   1. an unread count in the tab title, "(1) MatterWave" -- no permission,
 *      covers most of the value;
 *   2. a dot on the favicon, so a pinned tab shows it too;
 *   3. a system notification, only for someone who turned it on in
 *      Settings > Preferences, where the permission is asked from that
 *      click and never on load. Its body is the conversation's title and
 *      never the answer: a lock screen is a display nobody in the room
 *      agreed to. Clicking it brings the tab forward on that conversation.
 *
 * "Quiet" turns all three off. The choices are this device's (localStorage),
 * because the permission they depend on is this browser's.
 */

export interface AnswerReadyPrefs {
  /** No marker, no dot, no notification. */
  quiet: boolean;
  /** A system notification as well, once the browser allows it. */
  notify: boolean;
}

const PREFS_KEY = "mw-answer-ready";
const DEFAULTS: AnswerReadyPrefs = { quiet: false, notify: false };
const MARKER = /^\(\d+\) /;

let unread = 0;
let originalIcon: { link: HTMLLinkElement; href: string } | null = null;
let dottedIcon: Promise<string | null> | null = null;
let focusConversation: ((id: string) => void) | null = null;
const listeners = new Set<() => void>();
let cached: AnswerReadyPrefs | null = null;

export function readAnswerReadyPrefs(): AnswerReadyPrefs {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<AnswerReadyPrefs>) : {};
    cached = {
      quiet: parsed.quiet === true,
      notify: parsed.notify === true,
    };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

export function writeAnswerReadyPrefs(next: AnswerReadyPrefs): void {
  cached = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the choice holds for this page only.
  }
  for (const listener of listeners) listener();
}

export function useAnswerReadyPrefs(): AnswerReadyPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readAnswerReadyPrefs,
    readAnswerReadyPrefs,
  );
}

/** What the browser says about notifications, or "unsupported". */
export function notificationPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/**
 * Ask for the permission. Only ever called from the Preferences toggle's
 * click: a prompt that appears on load is one people learn to refuse.
 */
export async function requestNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** How the shell opens a conversation; registered while it is mounted. */
export function setAnswerReadyFocus(focus: ((id: string) => void) | null): void {
  focusConversation = focus;
}

/** The count in the title right now; tests read it. */
export function unreadAnswers(): number {
  return unread;
}

/**
 * A reply finished. Does nothing while the tab is visible -- the person is
 * looking at it -- or when they asked for quiet.
 */
export function announceAnswerReady(answer: { conversationId: string | null; title?: string | null }): void {
  if (typeof document === "undefined" || !document.hidden) return;
  const prefs = readAnswerReadyPrefs();
  if (prefs.quiet) return;
  unread += 1;
  document.title = `(${unread}) ${document.title.replace(MARKER, "")}`;
  void showDot();
  if (prefs.notify && notificationPermission() === "granted") {
    showNotification(answer.conversationId, answer.title ?? null);
  }
}

function showNotification(conversationId: string | null, title: string | null): void {
  try {
    const notification = new Notification(t`Your answer is ready`, {
      // The title only, never the reply.
      body: title ?? "MatterWave",
      tag: conversationId ? `mw-answer-${conversationId}` : "mw-answer",
      icon: "/icon-192.png",
    });
    notification.onclick = () => {
      window.focus();
      if (conversationId) focusConversation?.(conversationId);
      notification.close();
    };
  } catch {
    // A browser that grants the permission but cannot construct one here
    // (some mobile ones want a service worker): the title still carries it.
  }
}

/** The person is back: the marker and the dot go. */
export function clearAnswerReady(): void {
  if (unread === 0) return;
  unread = 0;
  if (typeof document !== "undefined") document.title = document.title.replace(MARKER, "");
  if (originalIcon) {
    originalIcon.link.href = originalIcon.href;
    originalIcon = null;
  }
}

/**
 * Listen for the tab coming back. Returns the cleanup; the shell installs
 * it once.
 */
export function installAnswerReady(): () => void {
  const onVisible = () => {
    if (!document.hidden) clearAnswerReady();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    clearAnswerReady();
  };
}

async function showDot(): Promise<void> {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (!link || originalIcon) return;
  const href = link.getAttribute("href") ?? "";
  dottedIcon ??= dotted(href);
  const dataUrl = await dottedIcon;
  // Came back while the icon was being drawn: nothing to mark.
  if (!dataUrl || unread === 0 || originalIcon) return;
  originalIcon = { link, href };
  link.href = dataUrl;
}

/** The brand icon with a dot in its corner, as an SVG data URL. */
async function dotted(href: string): Promise<string | null> {
  try {
    const res = await fetch(href);
    if (!res.ok) return null;
    const svg = await res.text();
    const end = svg.lastIndexOf("</svg>");
    if (end < 0) return null;
    // The theme's danger colour; an SVG favicon cannot read CSS variables,
    // so the value is resolved here.
    const fill =
      getComputedStyle(document.documentElement).getPropertyValue("--color-mw-danger-500").trim() || "crimson";
    const dot = `<circle cx="50" cy="14" r="12" fill="${fill}" stroke="white" stroke-width="3"/>`;
    return `data:image/svg+xml,${encodeURIComponent(svg.slice(0, end) + dot + svg.slice(end))}`;
  } catch {
    return null;
  }
}

/** Tests only. */
export function resetAnswerReadyForTests(): void {
  unread = 0;
  originalIcon = null;
  dottedIcon = null;
  focusConversation = null;
  cached = null;
}
