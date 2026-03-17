import { describe, it, expect } from 'vitest';
import { generateSecretBytes, encodeCredentials, decodeCredentials, encodeSecret1, base64UrlEncode } from '../crypto';

describe('generateSecretBytes', () => {
  it('returns a Uint8Array of the requested length', () => {
    const bytes = generateSecretBytes(32);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
  });

  it('produces different values on each call', () => {
    const a = generateSecretBytes(32);
    const b = generateSecretBytes(32);
    expect(a).not.toEqual(b);
  });
});

describe('encodeCredentials', () => {
  it('encodes 64 bytes into 86-char base64url string', () => {
    const secret1 = new Uint8Array(32).fill(1);
    const secret2 = new Uint8Array(32).fill(2);
    const encoded = encodeCredentials(secret1, secret2);
    expect(encoded.length).toBe(86);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('decodeCredentials', () => {
  it('round-trips with encodeCredentials', () => {
    const secret1 = new Uint8Array(32).fill(0xAA);
    const secret2 = new Uint8Array(32).fill(0xBB);
    const encoded = encodeCredentials(secret1, secret2);
    const decoded = decodeCredentials(encoded);
    expect(decoded.secret1Bytes).toEqual(secret1);
    expect(decoded.secret2Bytes).toEqual(secret2);
    expect(decoded.secret1Encoded).toBe(base64UrlEncode(secret1));
    expect(decoded.secret2Encoded).toBe(base64UrlEncode(secret2));
  });

  it('rejects credentials that decode to wrong byte length', () => {
    expect(() => decodeCredentials('too-short')).toThrow();
    expect(() => decodeCredentials('A'.repeat(85))).toThrow();
    expect(() => decodeCredentials('A'.repeat(100))).toThrow();
  });
});

describe('encodeSecret1', () => {
  it('encodes 32 bytes into 43-char base64url string', () => {
    const secret1 = new Uint8Array(32).fill(0xFF);
    const encoded = encodeSecret1(secret1);
    expect(encoded.length).toBe(43);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
