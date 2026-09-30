/**
 * SCIM requests shaped like the ones Okta and Microsoft Entra ID send
 * (from their SCIM 2.0 provisioning docs and captured traffic).
 */
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export const okta = {
  filterUser: (email: string) => `/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}&startIndex=1&count=100`,
  createUser: (email: string, externalId = "00u1ab2cd3EfGh4ij5k6") => ({
    schemas: [USER],
    userName: email,
    name: { givenName: "Jane", familyName: "Doe" },
    emails: [{ primary: true, value: email, type: "work" }],
    displayName: "Jane Doe",
    locale: "en-US",
    externalId,
    groups: [],
    password: "Tu3=zVf!pW9#kq",
    active: true,
  }),
  replaceUser: (id: string, email: string, externalId = "00u1ab2cd3EfGh4ij5k6") => ({
    schemas: [USER],
    id,
    userName: email,
    name: { givenName: "Janet", familyName: "Doe" },
    emails: [{ primary: true, value: email, type: "work" }],
    displayName: "Janet Doe",
    externalId,
    active: true,
  }),
  setActive: (active: boolean) => ({ schemas: [PATCH], Operations: [{ op: "replace", value: { active } }] }),
  createGroup: (displayName: string) => ({ schemas: [GROUP], displayName, members: [] }),
  addMembers: (ids: string[]) => ({
    schemas: [PATCH],
    Operations: [{ op: "add", path: "members", value: ids.map((value) => ({ value, display: value })) }],
  }),
  removeMember: (id: string) => ({
    schemas: [PATCH],
    Operations: [{ op: "remove", path: `members[value eq "${id}"]` }],
  }),
  renameGroup: (id: string, displayName: string) => ({
    schemas: [PATCH],
    Operations: [{ op: "replace", value: { id, displayName } }],
  }),
};

export const entra = {
  filterUser: (upn: string) => `/Users?filter=${encodeURIComponent(`userName eq "${upn}"`)}`,
  filterGroup: (name: string) =>
    `/Groups?excludedAttributes=members&filter=${encodeURIComponent(`displayName eq "${name}"`)}`,
  createUser: (upn: string, externalId = "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef") => ({
    schemas: [USER, ENTERPRISE],
    externalId,
    userName: upn,
    active: true,
    displayName: "Test User",
    emails: [{ primary: true, type: "work", value: upn }],
    meta: { resourceType: "User" },
    name: { formatted: "Test User", familyName: "User", givenName: "Test" },
    roles: [],
    [ENTERPRISE]: { department: "Support", employeeNumber: "4711" },
  }),
  disable: { schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: "False" }] },
  enable: { schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: "True" }] },
  updateAttributes: (upn: string) => ({
    schemas: [PATCH],
    Operations: [
      { op: "Replace", path: "displayName", value: "Tess User" },
      { op: "Add", path: "name.givenName", value: "Tess" },
      { op: "Replace", path: 'emails[type eq "work"].value', value: upn },
      { op: "Add", path: "title", value: "Support Lead" },
    ],
  }),
  createGroup: (displayName: string, externalId = "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159") => ({
    schemas: [GROUP],
    externalId,
    displayName,
    meta: { resourceType: "Group" },
  }),
  addMember: (id: string) => ({
    schemas: [PATCH],
    Operations: [{ op: "Add", path: "members", value: [{ value: id }] }],
  }),
  removeMember: (id: string) => ({
    schemas: [PATCH],
    Operations: [{ op: "Remove", path: "members", value: [{ value: id }] }],
  }),
};
