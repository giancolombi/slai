import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { type ReactNode, useSyncExternalStore } from "react";
import { cn } from "../lib/cn";

export type ToastTone = "info" | "success" | "error";

export interface ToastInput {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** Optional action; `altText` describes it for screen readers. */
  action?: { label: string; altText: string; onClick: () => void };
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
  open: boolean;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Show a toast from anywhere. Toasts are announced via an aria-live region (Radix Toast). */
export function toast(input: ToastInput): number {
  const id = nextId++;
  items = [...items.slice(-4), { ...input, id, open: true }];
  emit();
  return id;
}

export function dismissToast(id: number) {
  items = items.map((t) => (t.id === id ? { ...t, open: false } : t));
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, 300);
}

function useToasts() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
    () => items,
  );
}

const toneIcon = {
  info: <Info className="text-accent-text" aria-hidden />,
  success: <CircleCheck className="text-ok-text" aria-hidden />,
  error: <CircleAlert className="text-breached-text" aria-hidden />,
};

/** Mount once near the root. */
export function Toaster() {
  const list = useToasts();
  return (
    <ToastPrimitive.Provider swipeDirection="right" duration={5000}>
      {list.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          open={t.open}
          onOpenChange={(open) => !open && dismissToast(t.id)}
          duration={t.durationMs ?? (t.tone === "error" ? 8000 : 5000)}
          type={t.tone === "error" ? "foreground" : "background"}
          className={cn(
            "group pointer-events-auto relative flex w-full items-start gap-3 rounded-lg border border-line bg-raised p-3.5 pr-9 shadow-lg",
            "animate-slide-up data-[state=closed]:animate-fade-in data-[state=closed]:opacity-0",
            "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=end]:translate-x-full",
          )}
        >
          <span className="mt-0.5 flex [&_svg]:size-4">{toneIcon[t.tone ?? "info"]}</span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <ToastPrimitive.Title className="text-sm font-semibold text-ink">{t.title}</ToastPrimitive.Title>
            {t.description && (
              <ToastPrimitive.Description className="text-sm text-ink-muted">
                {t.description}
              </ToastPrimitive.Description>
            )}
            {t.action && (
              <ToastPrimitive.Action
                altText={t.action.altText}
                onClick={t.action.onClick}
                className="mt-1.5 self-start text-sm font-medium text-accent-text hover:underline"
              >
                {t.action.label}
              </ToastPrimitive.Action>
            )}
          </div>
          <ToastPrimitive.Close
            aria-label="Dismiss"
            className="absolute top-2.5 right-2.5 inline-flex size-6 items-center justify-center rounded-sm text-ink-subtle hover:bg-hover hover:text-ink"
          >
            <X className="size-3.5" aria-hidden />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed right-0 bottom-0 z-[var(--z-toast)] flex w-full max-w-sm flex-col gap-2 p-4 outline-none" />
    </ToastPrimitive.Provider>
  );
}
