import { describe, expect, it } from "vitest";
import type { CryptoProvider } from "../../lib/jesr/crypto-provider";
import type { Envelope } from "../../lib/jesr/protocol";
import { openEnvelope, sealEnvelope } from "../../lib/jesr/protocol";
import { deriveJesrId } from "../../lib/jesr/identity";

const TEST_NOW = 1_700_000_000_000;
const RECEIVER_ID = "JESR-RECEIVER";

function createTestCrypto(): CryptoProvider {
  const publicKey = new Uint8Array(64).fill(7);
  return {
    publicKey,
    async sign() { return new Uint8Array([1, 2, 3]); },
    async verify() { return true; },
    async sha256() { return new Uint8Array(32).fill(5); },
    async randomBytes(length) { return new Uint8Array(length).fill(1); },
    async encrypt() { return new Uint8Array([4, 5, 6]); },
    async decrypt() { return new Uint8Array([111, 107]); },
  };
}

describe("Jesr envelope validation", () => {
  it("opens a well-formed signed friend request", async () => {
    const crypto = createTestCrypto();
    const senderId = await deriveJesrId(crypto, crypto.publicKey);
    const envelope = await sealEnvelope(
      crypto,
      { jesrId: senderId, name: "مرسل" },
      { type: "friend-request", to: RECEIVER_ID, now: TEST_NOW },
    );

    const result = await openEnvelope(crypto, RECEIVER_ID, envelope, TEST_NOW);

    expect(result.ok).toBe(true);
  });

  it("rejects unsupported envelope types before signature processing", async () => {
    const crypto = createTestCrypto();
    const senderId = await deriveJesrId(crypto, crypto.publicKey);
    const envelope = await sealEnvelope(
      crypto,
      { jesrId: senderId, name: "مرسل" },
      { type: "friend-request", to: RECEIVER_ID, now: TEST_NOW },
    );
    const malformed = { ...envelope, type: "unknown-control" } as unknown as Envelope;

    expect(await openEnvelope(crypto, RECEIVER_ID, malformed, TEST_NOW)).toEqual({
      ok: false,
      reason: "bad-shape",
    });
  });

  it("rejects acknowledgements without a reference ID", async () => {
    const crypto = createTestCrypto();
    const senderId = await deriveJesrId(crypto, crypto.publicKey);
    const envelope = await sealEnvelope(
      crypto,
      { jesrId: senderId, name: "مرسل" },
      { type: "ack", to: RECEIVER_ID, ref: "packet-1", now: TEST_NOW },
    );
    const malformed = { ...envelope, ref: undefined };

    expect(await openEnvelope(crypto, RECEIVER_ID, malformed, TEST_NOW)).toEqual({
      ok: false,
      reason: "bad-shape",
    });
  });

  it("rejects messages without ciphertext", async () => {
    const crypto = createTestCrypto();
    const senderId = await deriveJesrId(crypto, crypto.publicKey);
    const envelope = await sealEnvelope(
      crypto,
      { jesrId: senderId, name: "مرسل" },
      {
        type: "msg",
        to: RECEIVER_ID,
        plaintext: "اختبار",
        peerPub: crypto.publicKey,
        now: TEST_NOW,
      },
    );
    const malformed = { ...envelope, ct: undefined };

    expect(await openEnvelope(crypto, RECEIVER_ID, malformed, TEST_NOW)).toEqual({
      ok: false,
      reason: "bad-shape",
    });
  });
});
