import { describe, expect, it } from "vitest";
import { emailOf, groupPatch, parseEqFilter, ScimError, userPatch } from "../src/scim/protocol.js";

const op = (o: string, path?: string, value?: unknown) => ({ op: o.toLowerCase(), path, value });

describe("SCIM PatchOp parsing", () => {
  it("folds Okta and Entra user operations", () => {
    expect(userPatch([op("replace", undefined, { active: false })])).toEqual({ active: false });
    expect(userPatch([op("Replace", "active", "False")])).toEqual({ active: false });
    expect(userPatch([op("Replace", "active", "True")])).toEqual({ active: true });
    expect(
      userPatch([
        op("Replace", "displayName", "Tess User"),
        op("Add", "name.givenName", "Tess"),
        op("Replace", 'emails[type eq "work"].value', "x@y.example"),
        op("Add", "title", "Lead"),
      ]),
    ).toEqual({ displayName: "Tess User", givenName: "Tess" });
    expect(userPatch([op("replace", undefined, { name: { familyName: "Doe" }, externalId: "e1" })])).toEqual({
      familyName: "Doe",
      externalId: "e1",
    });
    expect(userPatch([op("remove", "externalId")])).toEqual({ externalId: null });
    expect(() => userPatch([op("replace", "active", "maybe")])).toThrow(ScimError);
    expect(() => userPatch([op("move", "active", true)])).toThrow(ScimError);
  });

  it("folds Okta and Entra group operations", () => {
    expect(groupPatch([op("add", "members", [{ value: "a" }, { value: "b" }])])).toEqual({
      add: ["a", "b"],
      remove: [],
    });
    expect(groupPatch([op("remove", 'members[value eq "a"]')])).toEqual({ add: [], remove: ["a"] });
    expect(groupPatch([op("Remove", "members", [{ value: "a" }])])).toEqual({ add: [], remove: ["a"] });
    expect(groupPatch([op("remove", "members")])).toEqual({ add: [], remove: [], replace: [] });
    expect(groupPatch([op("replace", undefined, { id: "g", displayName: "New" })])).toEqual({
      add: [],
      remove: [],
      displayName: "New",
    });
    expect(groupPatch([op("replace", "members", [{ value: "c" }])])).toEqual({ add: [], remove: [], replace: ["c"] });
    expect(() => groupPatch([op("add", "members", [{ nope: 1 }])])).toThrow(ScimError);
  });
});

describe("SCIM filters and identities", () => {
  it("parses eq filters case-insensitively and rejects the rest", () => {
    expect(parseEqFilter('userName eq "a@b.example"', ["userName"])).toEqual({
      attr: "userName",
      value: "a@b.example",
    });
    expect(parseEqFilter('USERNAME EQ "x"', ["userName"])).toEqual({ attr: "userName", value: "x" });
    expect(parseEqFilter(undefined, ["userName"])).toBeNull();
    expect(() => parseEqFilter('userName co "a"', ["userName"])).toThrow(ScimError);
    expect(() => parseEqFilter('title eq "a"', ["userName"])).toThrow(ScimError);
  });

  it("takes the email from userName or the primary email", () => {
    expect(emailOf({ userName: "Jane@Acme.example" })).toBe("jane@acme.example");
    expect(
      emailOf({
        userName: "jdoe",
        emails: [{ value: "other@acme.example" }, { value: "j@acme.example", primary: true }],
      }),
    ).toBe("j@acme.example");
    expect(emailOf({ userName: "jdoe" })).toBeNull();
  });
});
