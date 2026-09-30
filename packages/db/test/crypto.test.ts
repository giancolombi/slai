import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeyring, DecryptError, decrypt, decryptJson, encrypt, encryptJson, keyIdOf } from "../src/crypto.js";

const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");
const ring1 = createKeyring({ key: k1, keyId: "k1" });

describe("encrypt/decrypt", () => {
  it("round-trips text and JSON", () => {
    const ct = encrypt("hunter2 🔑", { keyring: ring1 });
    expect(decrypt(ct, { keyring: ring1 })).toBe("hunter2 🔑");
    const creds = { subdomain: "acme", token: "zd-123" };
    expect(decryptJson(encryptJson(creds, { keyring: ring1 }), { keyring: ring1 })).toEqual(creds);
  });

  it("prefixes the key id and never contains the plaintext", () => {
    const ct = encrypt("super-secret-token", { keyring: ring1 });
    expect(ct.startsWith("v1.k1.")).toBe(true);
    expect(keyIdOf(ct)).toBe("k1");
    expect(ct).not.toContain("super-secret-token");
  });

  it("uses a fresh IV each time", () => {
    expect(encrypt("same", { keyring: ring1 })).not.toBe(encrypt("same", { keyring: ring1 }));
  });

  it("detects tampering", () => {
    const parts = encrypt("value", { keyring: ring1 }).split(".");
    const ct = Buffer.from(parts[4]!, "base64url");
    ct[0] = ct[0]! ^ 1;
    parts[4] = ct.toString("base64url");
    expect(() => decrypt(parts.join("."), { keyring: ring1 })).toThrow(DecryptError);
  });

  it("binds ciphertext to its AAD context", () => {
    const ct = encrypt("token", { keyring: ring1, aad: "connection:a" });
    expect(decrypt(ct, { keyring: ring1, aad: "connection:a" })).toBe("token");
    expect(() => decrypt(ct, { keyring: ring1, aad: "connection:b" })).toThrow(DecryptError);
  });

  it("supports key rotation: old ciphertext still decrypts, new writes use the new key", () => {
    const old = encrypt("rotating", { keyring: ring1 });
    const ring2 = createKeyring({ key: k2, keyId: "k2", previous: `k1:${k1}` });
    expect(decrypt(old, { keyring: ring2 })).toBe("rotating");
    expect(keyIdOf(encrypt("new", { keyring: ring2 }))).toBe("k2");
    expect(() => decrypt(encrypt("new", { keyring: ring2 }), { keyring: ring1 })).toThrow(/unknown encryption key/);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => createKeyring({ key: randomBytes(16).toString("base64"), keyId: "k1" })).toThrow(/32 bytes/);
  });
});
