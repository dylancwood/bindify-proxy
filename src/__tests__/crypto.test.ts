import { describe, it, expect } from 'vitest';
import { encryptTokenData, decryptTokenData, deriveManagedEncryptionKey, encryptTokenDataWithKey, decryptTokenDataWithKey, parseManagedKeys, getManagedKey, getActiveKey, computeKeyFingerprint } from '../crypto';

describe('Zero-knowledge encryption', () => {
  it('encrypts and decrypts token data', async () => {
    const data = JSON.stringify({ access_token: 'abc', refresh_token: 'def', expires_at: 123 });
    const secret = 'my-secret-key-uuid';
    const encrypted = await encryptTokenData(data, secret);
    expect(encrypted).not.toBe(data);
    const decrypted = await decryptTokenData(encrypted, secret);
    expect(decrypted).toBe(data);
  });

  it('fails to decrypt with wrong key', async () => {
    const data = 'sensitive data';
    const encrypted = await encryptTokenData(data, 'correct-key');
    await expect(decryptTokenData(encrypted, 'wrong-key')).rejects.toThrow();
  });

  it('produces different ciphertext for same plaintext (random IV)', async () => {
    const data = 'same data';
    const key = 'same-key';
    const enc1 = await encryptTokenData(data, key);
    const enc2 = await encryptTokenData(data, key);
    expect(enc1).not.toBe(enc2); // Different IVs
  });
});

describe('Managed encryption', () => {
  it('derives consistent key for same connection ID', async () => {
    const masterKey = 'test-master-key-abcdef1234567890';
    const connectionId = 'conn-123';
    const key1 = await deriveManagedEncryptionKey(masterKey, connectionId, true);
    const key2 = await deriveManagedEncryptionKey(masterKey, connectionId, true);
    const raw1 = await crypto.subtle.exportKey('raw', key1) as ArrayBuffer;
    const raw2 = await crypto.subtle.exportKey('raw', key2) as ArrayBuffer;
    expect(new Uint8Array(raw1)).toEqual(new Uint8Array(raw2));
  });

  it('derives different keys for different connection IDs', async () => {
    const masterKey = 'test-master-key-abcdef1234567890';
    const key1 = await deriveManagedEncryptionKey(masterKey, 'conn-aaa', true);
    const key2 = await deriveManagedEncryptionKey(masterKey, 'conn-bbb', true);
    const raw1 = await crypto.subtle.exportKey('raw', key1) as ArrayBuffer;
    const raw2 = await crypto.subtle.exportKey('raw', key2) as ArrayBuffer;
    expect(new Uint8Array(raw1)).not.toEqual(new Uint8Array(raw2));
  });

  it('encrypts and decrypts with managed key', async () => {
    const masterKey = 'test-master-key-abcdef1234567890';
    const connectionId = 'conn-123';
    const key = await deriveManagedEncryptionKey(masterKey, connectionId);
    const data = JSON.stringify({ access_token: 'abc', refresh_token: 'def', expires_at: 123 });
    const encrypted = await encryptTokenDataWithKey(data, key);
    expect(encrypted).not.toBe(data);
    const decrypted = await decryptTokenDataWithKey(encrypted, key);
    expect(decrypted).toBe(data);
  });

  it('fails to decrypt managed data with wrong connection ID', async () => {
    const masterKey = 'test-master-key-abcdef1234567890';
    const correctKey = await deriveManagedEncryptionKey(masterKey, 'conn-correct');
    const wrongKey = await deriveManagedEncryptionKey(masterKey, 'conn-wrong');
    const data = 'sensitive data';
    const encrypted = await encryptTokenDataWithKey(data, correctKey);
    await expect(decryptTokenDataWithKey(encrypted, wrongKey)).rejects.toThrow();
  });
});

describe('parseManagedKeys', () => {
  it('parses valid JSON array and computes fingerprints', async () => {
    const key1 = 'a'.repeat(64);
    const key2 = 'b'.repeat(64);
    const json = JSON.stringify([{ key: key1 }, { key: key2 }]);
    const keys = await parseManagedKeys(json);
    expect(keys).toHaveLength(2);
    expect(keys[0].key).toBe(key1);
    expect(keys[0].fingerprint).toHaveLength(16);
    expect(keys[1].key).toBe(key2);
    expect(keys[0].fingerprint).not.toBe(keys[1].fingerprint);
  });

  it('rejects non-array JSON', async () => {
    await expect(parseManagedKeys('{"key":"abc"}')).rejects.toThrow('must be a JSON array');
  });

  it('rejects empty array', async () => {
    await expect(parseManagedKeys('[]')).rejects.toThrow('at least one key');
  });

  it('rejects entries with empty key', async () => {
    await expect(parseManagedKeys('[{"key":""}]')).rejects.toThrow('non-empty string');
  });

  it('rejects duplicate fingerprints', async () => {
    const key = 'a'.repeat(64);
    const json = JSON.stringify([{ key }, { key }]);
    await expect(parseManagedKeys(json)).rejects.toThrow('Duplicate key fingerprint');
  });
});

describe('getManagedKey', () => {
  it('returns key for matching fingerprint', async () => {
    const key1 = 'a'.repeat(64);
    const keys = await parseManagedKeys(JSON.stringify([{ key: key1 }]));
    const result = getManagedKey(keys, keys[0].fingerprint);
    expect(result).toBe(key1);
  });

  it('throws for unknown fingerprint', async () => {
    const keys = await parseManagedKeys(JSON.stringify([{ key: 'a'.repeat(64) }]));
    expect(() => getManagedKey(keys, 'nonexistent12345a')).toThrow(
      'No managed encryption key found for fingerprint nonexistent12345a'
    );
  });
});

describe('getActiveKey', () => {
  it('returns last entry in array', async () => {
    const key1 = 'a'.repeat(64);
    const key2 = 'b'.repeat(64);
    const keys = await parseManagedKeys(JSON.stringify([{ key: key1 }, { key: key2 }]));
    const active = getActiveKey(keys);
    expect(active.key).toBe(key2);
  });

  it('returns sole entry when only one key', async () => {
    const key1 = 'a'.repeat(64);
    const keys = await parseManagedKeys(JSON.stringify([{ key: key1 }]));
    const active = getActiveKey(keys);
    expect(active.key).toBe(key1);
  });
});

describe('computeKeyFingerprint', () => {
  it('returns first 16 hex chars of SHA-256 of key hex string', async () => {
    const keyHex = 'a'.repeat(64);
    const fingerprint = await computeKeyFingerprint(keyHex);
    expect(fingerprint).toHaveLength(16);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces different fingerprints for different keys', async () => {
    const fp1 = await computeKeyFingerprint('a'.repeat(64));
    const fp2 = await computeKeyFingerprint('b'.repeat(64));
    expect(fp1).not.toBe(fp2);
  });

  it('produces consistent fingerprints for the same key', async () => {
    const key = 'deadbeef'.repeat(8);
    const fp1 = await computeKeyFingerprint(key);
    const fp2 = await computeKeyFingerprint(key);
    expect(fp1).toBe(fp2);
  });
});
