import { useEffect, useRef } from "react";

export interface InboxKeyHandlers {
  onNext: () => void;
  onPrev: () => void;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
}

/** True while focus is somewhere text can be typed, so single-letter shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

/**
 * Inbox shortcuts: j/k move, a approves, r rejects, e edits, Escape leaves the editor.
 * Ignored while typing, with modifier keys, or while `enabled` is false (e.g. a dialog is open).
 */
export function useInboxKeys(handlers: InboxKeyHandlers, enabled = true) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      const h = ref.current;
      switch (e.key) {
        case "j":
        case "ArrowDown":
          h.onNext();
          break;
        case "k":
        case "ArrowUp":
          h.onPrev();
          break;
        case "a":
          h.onApprove();
          break;
        case "r":
          h.onReject();
          break;
        case "e":
          h.onEdit();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
