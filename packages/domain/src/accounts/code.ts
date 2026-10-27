/** Single-use credentials. Only the hash is persisted; plaintext exists in the delivered e-mail. */
import { Crypto, Effect, Schema } from "effect";
import { encode as encodeBase64Url } from "effect/encoding/Base64Url";
import { encode as encodeHex } from "effect/encoding/Hex";

import { PersonId } from "../shared/ids.ts";

export const CodePurpose = Schema.Literals(["activation", "resetPassword"]);

export type CodePurpose = typeof CodePurpose.Type;

/** The command and lifetime associated with each purpose are domain data. */
export const codePolicy = {
  activation: { command: "activate", lifetimeSeconds: 14 * 24 * 60 * 60 },
  resetPassword: { command: "resetPassword", lifetimeSeconds: 24 * 60 * 60 },
} as const satisfies Record<
  CodePurpose,
  { readonly command: string; readonly lifetimeSeconds: number }
>;

/** A SHA-256 digest, encoded as lowercase hexadecimal. */
export const CodeHash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a SHA-256 digest" })
).pipe(Schema.brand("CodeHash"));

export type CodeHash = typeof CodeHash.Type;

/** A prefix and the unpadded base64url representation of 256 random bits. */
export const CodeToken = Schema.String.check(
  Schema.isPattern(/^c_[A-Za-z0-9_-]{43}$/u, {
    expected: "a 256-bit single-use code",
  })
).pipe(Schema.brand("CodeToken"));

export type CodeToken = typeof CodeToken.Type;

export const Code = Schema.Struct({
  expiresAt: Schema.DateTimeUtc,
  hash: CodeHash,
  purpose: CodePurpose,
  subject: PersonId,
  usedAt: Schema.NullOr(Schema.DateTimeUtc),
});

export type Code = typeof Code.Type;

const utf8 = new TextEncoder();

/** Hash the exact token presented by a caller; plaintext never enters a repository. */
export const hashCode = Effect.fn("Code.hash")(function* hashCode(
  token: CodeToken
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", utf8.encode(token));

  return CodeHash.make(encodeHex(digest));
});

/** Generate 256 random bits and the hash to store. Call only when delivering a message. */
export const mintCode = Effect.fn("Code.mint")(function* mintCode() {
  const crypto = yield* Crypto.Crypto;

  const token = CodeToken.make(
    `c_${encodeBase64Url(yield* crypto.randomBytes(32))}`
  );

  return { hash: yield* hashCode(token), token };
});
