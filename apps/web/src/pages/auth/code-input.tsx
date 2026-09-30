import { cn } from "@slai/ui";
import { type ClipboardEvent, type KeyboardEvent, useEffect, useRef } from "react";

export interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Called when all six digits are present. */
  onComplete?: (value: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  /** id of the element describing errors. */
  describedBy?: string;
  autoFocus?: boolean;
}

const LENGTH = 6;

/**
 * Six single-digit boxes that behave like one field: typing advances, Backspace goes back,
 * arrows move, and pasting a code fills every box. Autofill of one-time codes lands in box one.
 */
export function CodeInput({ value, onChange, onComplete, invalid, disabled, describedBy, autoFocus }: CodeInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: LENGTH }, (_, i) => value[i] ?? "");

  const commit = (next: string) => {
    const clean = next.replace(/\D/g, "").slice(0, LENGTH);
    onChange(clean);
    if (clean.length === LENGTH) onComplete?.(clean);
    return clean;
  };

  const focus = (i: number) => refs.current[Math.max(0, Math.min(LENGTH - 1, i))]?.focus();

  // After a rejected code the boxes are cleared; put the cursor back in the first one.
  useEffect(() => {
    if (invalid && !disabled) refs.current[0]?.focus();
  }, [invalid, disabled]);

  const onInput = (i: number, raw: string) => {
    const typed = raw.replace(/\D/g, "");
    if (!typed) return;
    if (typed.length > 1) {
      // Autofill or fast typing: treat as a paste from this position.
      const clean = commit(value.slice(0, i) + typed);
      focus(clean.length);
      return;
    }
    const arr = digits.slice();
    arr[i] = typed;
    const clean = commit(arr.join(""));
    focus(Math.min(i + 1, clean.length));
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      const arr = digits.slice();
      if (arr[i]) {
        arr[i] = "";
        commit(arr.join("").slice(0, i) + arr.slice(i + 1).join(""));
      } else if (i > 0) {
        commit(value.slice(0, i - 1) + value.slice(i));
        focus(i - 1);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focus(i - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focus(i + 1);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const clean = commit(e.clipboardData.getData("text"));
    focus(clean.length);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add a visible legend; the group is labelled instead
    <div role="group" aria-label="6-digit code" className="flex justify-between gap-2" aria-describedby={describedBy}>
      {digits.map((d, i) => (
        <input
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed six positions
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          onChange={(e) => onInput(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
          onFocus={(e) => e.target.select()}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          // biome-ignore lint/a11y/noAutofocus: the code is the only task on this screen
          autoFocus={autoFocus && i === 0}
          disabled={disabled}
          aria-label={`Digit ${i + 1} of ${LENGTH}`}
          aria-invalid={invalid || undefined}
          className={cn(
            "h-12 w-full min-w-0 rounded-md border bg-surface text-center font-mono text-xl font-medium text-ink shadow-xs tnum",
            "transition-[border-color,box-shadow] focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/20 focus-visible:outline-none",
            invalid ? "border-breached" : "border-line-strong",
            "disabled:bg-sunken disabled:text-ink-muted",
          )}
        />
      ))}
    </div>
  );
}
