import { type PolicyInput, policySchema } from "@slai/sla-engine";
import { type Budget, InvalidOutputError } from "../budget.js";
import { normalizeForMatch, uncitedAmbiguities, verifyCitations } from "../citations.js";
import { type LoadedDocument, loadDocument } from "../documents.js";
import { formatIssues } from "../providers/parse.js";
import type { ChatMessage, ContentPart, GenerateResult } from "../providers/types.js";
import { type ExtractionDraft, extractionDraftSchema, toPolicyInput } from "../schemas.js";
import type { ContractDocument, ContractExtraction } from "../types.js";
import { dataBlock } from "./data-block.js";
import { EXTRACT_SYSTEM, REPAIR_INSTRUCTION } from "./extract-prompt.js";

export interface ExtractionData {
  docs: { filename: string; text: string }[];
}

/** Anthropic reads PDFs natively; everything else (and every provider's fallback) gets the extracted text. */
export function documentParts(docs: LoadedDocument[]): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const d of docs) {
    if (d.mediaType === "application/pdf") parts.push({ type: "pdf", filename: d.filename, base64: d.base64 });
  }
  const blocks = docs.map((d, i) =>
    dataBlock(
      "CONTRACT_DOCUMENT",
      { index: i, name: d.filename, format: d.mediaType === "application/pdf" ? "pdf-extracted-text" : d.mediaType },
      d.text,
    ),
  );
  parts.push({
    type: "text",
    text: `${blocks.join("\n\n")}\n\nExtract the SLA policies from the contract document(s) above. Use each document's name attribute as the citation document. Return the JSON.`,
  });
  return parts;
}

/** Maps and validates every proposed policy with the engine's schema. */
function validatePolicies(draft: ExtractionDraft): { policies: PolicyInput[]; issues: string[] } {
  const policies: PolicyInput[] = [];
  const issues: string[] = [];
  draft.policies.forEach((p, i) => {
    const parsed = policySchema.safeParse(toPolicyInput(p));
    if (parsed.success) policies.push(parsed.data as PolicyInput);
    else issues.push(...formatIssues(parsed.error.issues).map((m) => `policies[${i}].${m}`));
  });
  if (draft.policies.length === 0) issues.push("policies: at least one policy is required");
  return { policies, issues };
}

type Attempt =
  | { ok: true; draft: ExtractionDraft; policies: PolicyInput[] }
  | { ok: false; issues: string[]; text: string };

function check(res: GenerateResult<ExtractionDraft>): Attempt {
  if (!res.ok) return { ok: false, issues: res.issues, text: res.text };
  const { policies, issues } = validatePolicies(res.value);
  return issues.length ? { ok: false, issues, text: res.text } : { ok: true, draft: res.value, policies };
}

export async function extractContract(input: ContractDocument[], budget: Budget): Promise<ContractExtraction> {
  if (input.length === 0) throw new InvalidOutputError("no documents", ["at least one document is required"]);
  const docs = await Promise.all(input.map(loadDocument));
  const data: ExtractionData = { docs: docs.map((d) => ({ filename: d.filename, text: d.text })) };
  const messages: ChatMessage[] = [{ role: "user", content: documentParts(docs) }];
  const request = {
    task: "contract_extraction" as const,
    system: EXTRACT_SYSTEM,
    schemaName: "contract_extraction",
    schema: extractionDraftSchema,
    data,
  };

  let attempt = check(await budget.generate({ ...request, messages }));
  if (!attempt.ok) {
    // One repair round-trip: show the model its output and the validation issues.
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: [{ type: "text", text: attempt.text || "{}" }] },
      { role: "user", content: [{ type: "text", text: REPAIR_INSTRUCTION(attempt.issues) }] },
    ];
    attempt = check(await budget.generate({ ...request, messages: repairMessages }));
    if (!attempt.ok) throw new InvalidOutputError("extraction invalid after repair", attempt.issues);
  }

  const { draft, policies } = attempt;
  const { verified } = verifyCitations(draft.citations, docs);
  const allText = docs.map((d) => normalizeForMatch(d.text));
  const ambiguities = draft.ambiguities.map((a) =>
    a.quote && !allText.some((t) => t.includes(normalizeForMatch(a.quote!))) ? { ...a, quote: null } : a,
  );
  return {
    policies,
    citations: verified,
    ambiguities: [...ambiguities, ...uncitedAmbiguities(policies, verified)],
    parties: draft.parties,
    summary: draft.summary,
  };
}
