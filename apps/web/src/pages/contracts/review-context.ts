import { createContext, useContext } from "react";

export interface Citation {
  path: string;
  quote: string;
  document: string;
  page: number | null;
}

export interface ReviewContextValue {
  citations: Map<string, Citation>;
  /** Paths the extractor flagged as ambiguous. */
  ambiguous: Set<string>;
  /** Ambiguous paths still waiting for a decision. */
  unresolved: Set<string>;
  /** Schema problems by path. */
  issues: Map<string, string>;
  activePath: string | null;
  readOnly: boolean;
  activate: (path: string | null, via: "focus" | "hover") => void;
  showCitation: (path: string) => void;
}

export const ReviewContext = createContext<ReviewContextValue>({
  citations: new Map(),
  ambiguous: new Set(),
  unresolved: new Set(),
  issues: new Map(),
  activePath: null,
  readOnly: false,
  activate: () => {},
  showCitation: () => {},
});

export const useReview = () => useContext(ReviewContext);
