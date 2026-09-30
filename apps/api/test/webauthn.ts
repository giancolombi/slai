/**
 * A minimal software WebAuthn authenticator for tests: one P-256 credential,
 * "none" attestation, user presence + user verification flags.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private counter = 0;

  constructor(
    private readonly origin: string,
    private readonly rpId = new URL(origin).hostname,
  ) {}

  private authData(flags: number, attested?: Uint8Array): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter++);
    return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  /** navigator.credentials.create() */
  register(options: { challenge: string }, opts: { userVerified?: boolean } = {}) {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLen, this.credentialId, Buffer.from(cose)]);
    const flags = 0x01 | 0x40 | (opts.userVerified === false ? 0 : 0x04);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", this.authData(flags, attested)],
      ]) as never,
    );
    const clientDataJSON = JSON.stringify({
      type: "webauthn.create",
      challenge: options.challenge,
      origin: this.origin,
    });
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64u(Buffer.from(clientDataJSON)),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get() */
  authenticate(options: { challenge: string }, opts: { userVerified?: boolean } = {}) {
    const authenticatorData = this.authData(0x01 | (opts.userVerified === false ? 0 : 0x04));
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin }),
    );
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), {
      key: this.keys.privateKey,
      dsaEncoding: "der",
    });
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
