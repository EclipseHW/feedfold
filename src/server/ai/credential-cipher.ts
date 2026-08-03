import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { AiProvider } from "../../shared/types.js";
import { AiError } from "./errors.js";

const KEY_HEX_LENGTH = 64;
const NONCE_BYTES = 12;
const ENVELOPE_VERSION = "v1";

function associatedData(userId: number, provider: AiProvider): Buffer {
  return Buffer.from(`${userId}:${provider}`, "utf8");
}

export interface CredentialCipherLike {
  encrypt(userId: number, provider: AiProvider, plaintext: string): string;
  decrypt(userId: number, provider: AiProvider, envelope: string): string;
}

export class CredentialCipher implements CredentialCipherLike {
  private constructor(private readonly key: Buffer) {}

  static fromHex(value: string | undefined): CredentialCipher | null {
    if (value === undefined || value.trim() === "") return null;
    const normalized = value.trim();
    if (normalized.length !== KEY_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(normalized)) {
      throw new Error("AI_CREDENTIALS_KEY must contain exactly 64 hexadecimal characters");
    }
    return new CredentialCipher(Buffer.from(normalized, "hex"));
  }

  encrypt(userId: number, provider: AiProvider, plaintext: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(associatedData(userId, provider));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      ENVELOPE_VERSION,
      nonce.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  decrypt(userId: number, provider: AiProvider, envelope: string): string {
    try {
      const [version, nonceValue, tagValue, ciphertextValue, extra] = envelope.split(".");
      if (
        version !== ENVELOPE_VERSION ||
        !nonceValue ||
        !tagValue ||
        !ciphertextValue ||
        extra !== undefined
      ) {
        throw new Error("Invalid credential envelope");
      }
      const nonce = Buffer.from(nonceValue, "base64url");
      const tag = Buffer.from(tagValue, "base64url");
      if (nonce.length !== NONCE_BYTES || tag.length !== 16) {
        throw new Error("Invalid credential envelope fields");
      }
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(associatedData(userId, provider));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new AiError(
        "AI_CREDENTIAL_UNREADABLE",
        409,
        "echovale could not decrypt the saved API key. Enter it again in Settings.",
      );
    }
  }
}
