import type { Connection } from "@slai/shared";
import { describe, expect, it } from "vitest";
import { eligibleConnections, matchesArticle, safeHref, uniqueRefs, urlHost } from "../src/lib/knowledge";

const article = {
  title: "Fix SAML audience mismatch errors",
  bodyText: "If Okta reports an audience mismatch, check the Audience URI in your IdP.",
};

describe("matchesArticle", () => {
  it("matches every word, case-insensitively, across title and body", () => {
    expect(matchesArticle(article, "saml OKTA")).toBe(true);
    expect(matchesArticle(article, "  audience   uri ")).toBe(true);
  });
  it("rejects when any word is missing", () => {
    expect(matchesArticle(article, "saml webhook")).toBe(false);
  });
  it("matches everything for an empty query", () => {
    expect(matchesArticle(article, "")).toBe(true);
    expect(matchesArticle(article, undefined)).toBe(true);
  });
});

describe("links", () => {
  it("only renders http(s) links", () => {
    expect(safeHref("https://help.acme-cloud.example/sso")).toBe("https://help.acme-cloud.example/sso");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
  it("shows the host", () => {
    expect(urlHost("https://help.acme-cloud.example/a/b")).toBe("help.acme-cloud.example");
    expect(urlHost("nope")).toBeNull();
  });
});

describe("uniqueRefs", () => {
  it("drops duplicates and keeps order", () => {
    const a = { id: "a", title: "A", url: null };
    const gone = { id: null, title: "Old", url: "https://x.example/old" };
    expect(uniqueRefs([a, gone, { ...a }, { ...gone }])).toEqual([a, gone]);
    expect(uniqueRefs(undefined)).toEqual([]);
  });
});

describe("eligibleConnections", () => {
  const conn = (id: string, provider: string) => ({ id, provider }) as unknown as Connection;
  const connectors = [
    { provider: "zendesk", supportsKnowledge: true, supportsSavedReplies: true },
    { provider: "help_scout", supportsSavedReplies: true },
    { provider: "jira_sm" },
  ];
  const connections = [conn("z", "zendesk"), conn("h", "help_scout"), conn("j", "jira_sm")];

  it("offers each kind only where the connector supports it and no source of that kind exists", () => {
    const sources = [{ kind: "helpdesk_articles" as const, connectionId: "z" }];
    expect(eligibleConnections("helpdesk_articles", connectors, connections, sources)).toEqual([]);
    const replies = eligibleConnections("saved_replies", connectors, connections, sources);
    expect(replies.map((c) => c.id)).toEqual(["z", "h"]);
    const all = [...sources, { kind: "saved_replies" as const, connectionId: "h" }];
    expect(eligibleConnections("saved_replies", connectors, connections, all).map((c) => c.id)).toEqual(["z"]);
  });
});
