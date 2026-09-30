import type { Contract } from "@slai/shared";
import { Button, cn, IconButton, Progress, Select, toast } from "@slai/ui";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, FileText, UploadCloud, X } from "lucide-react";
import { type DragEvent, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { qk, useCustomers } from "../../lib/queries";

export const ACCEPTED = [".pdf", ".docx", ".txt", ".md"];
export const MAX_BYTES = 20 * 1024 * 1024;

/** Client-side check mirroring the API's limits. Returns an error message or null. */
export function validateContractFile(file: { name: string; size: number }): string | null {
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!ACCEPTED.includes(ext)) return "Upload a PDF, DOCX, TXT or Markdown file.";
  if (file.size > MAX_BYTES) return "Contracts must be 20 MB or smaller.";
  if (file.size === 0) return "This file is empty.";
  return null;
}

interface Item {
  key: string;
  name: string;
  size: number;
  progress: number;
  state: "uploading" | "done" | "error";
  error?: string;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface ContractUploadProps {
  /** Fix the customer; omit to let the uploader choose (or leave unassigned). */
  customerAccountId?: string | null;
  onUploaded?: (contract: Contract) => void;
  compact?: boolean;
}

/** Drag-and-drop (or browse) contract upload with validation and real progress. */
export function ContractUpload({ customerAccountId, onUploaded, compact = false }: ContractUploadProps) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [over, setOver] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const chooseCustomer = customerAccountId === undefined;
  const customers = useCustomers();
  const [customer, setCustomer] = useState<string>("none");

  const patch = (key: string, p: Partial<Item>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));

  const upload = async (file: File) => {
    const key = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
    const invalid = validateContractFile(file);
    setItems((list) => [
      ...list,
      {
        key,
        name: file.name,
        size: file.size,
        progress: 0,
        state: invalid ? "error" : "uploading",
        error: invalid ?? undefined,
      },
    ]);
    if (invalid) return;
    const cust = chooseCustomer ? (customer === "none" ? null : customer) : (customerAccountId ?? null);
    try {
      const contract = await api.contracts.upload(file, cust, (f) => patch(key, { progress: Math.round(f * 100) }));
      patch(key, { progress: 100, state: "done" });
      void queryClient.invalidateQueries({ queryKey: qk.contracts });
      toast({
        tone: "success",
        title: "Contract uploaded",
        description: "Extracting SLA terms. This takes under a minute.",
      });
      onUploaded?.(contract);
    } catch (e) {
      patch(key, { state: "error", error: errorMessage(e) });
    }
  };

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) void upload(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    onFiles(e.dataTransfer.files);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target; the Browse button is the keyboard path */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          "relative flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed text-center transition-colors",
          compact ? "px-4 py-6" : "px-6 py-10",
          over ? "border-accent bg-accent-subtle/60" : "border-line-strong bg-surface hover:border-ink-subtle/60",
        )}
      >
        <span
          className={cn(
            "flex items-center justify-center rounded-xl border bg-sunken text-ink-muted",
            compact ? "size-9" : "size-11",
            over && "border-accent text-accent-text",
          )}
          aria-hidden
        >
          <UploadCloud className="size-5" />
        </span>
        <div>
          <p className="text-sm font-medium text-ink">
            {over ? "Drop to upload" : "Drop your MSA, SLA schedule or order form here"}
          </p>
          <p id={hintId} className="mt-0.5 text-xs text-ink-muted">
            PDF, DOCX, TXT or Markdown · up to 20 MB · several at once is fine
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="primary" size="sm" onClick={() => inputRef.current?.click()} aria-describedby={hintId}>
            Browse files
          </Button>
          {chooseCustomer && (
            <div className="w-56">
              <Select
                size="sm"
                aria-label="Customer this contract belongs to"
                value={customer}
                onValueChange={setCustomer}
                options={[
                  { value: "none", label: "No customer (default terms)" },
                  ...(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
            </div>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Uploads" aria-live="polite">
          {items.map((i) => (
            <li key={i.key} className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5">
              <FileText className="size-4 shrink-0 text-ink-subtle" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">{i.name}</span>
                  <span className="shrink-0 font-mono text-2xs text-ink-muted tnum">
                    {i.state === "uploading" ? `${i.progress}%` : formatBytes(i.size)}
                  </span>
                </div>
                {i.state === "uploading" && (
                  <Progress className="mt-1.5" label={`Uploading ${i.name}`} value={i.progress} />
                )}
                {i.state === "error" && (
                  <p role="alert" className="mt-0.5 flex items-center gap-1 text-xs text-breached-text">
                    <CircleAlert className="size-3.5" aria-hidden />
                    {i.error}
                  </p>
                )}
                {i.state === "done" && (
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-ok-text">
                    <CircleCheck className="size-3.5" aria-hidden />
                    Uploaded · extracting SLA terms
                  </p>
                )}
              </div>
              {i.state !== "uploading" && (
                <IconButton
                  size="sm"
                  label={`Dismiss ${i.name}`}
                  icon={<X />}
                  onClick={() => setItems((list) => list.filter((x) => x.key !== i.key))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
