import { describe, it, expect } from 'vitest';
import { encryptTokenData, decryptTokenData, deriveManagedEncryptionKey, encryptTokenDataWithKey, decryptTokenDataWithKey, parseManagedKeys, getManagedKey, getActiveKeyVersion, computeKeyFingerprint } from '../crypto';

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
  it('parses valid JSON array', () => {
    const keys = parseManagedKeys('[{"version":1,"key":"aabbcc"},{"version":2,"key":"ddeeff"}]');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual({ version: 1, key: 'aabbcc' });
    expect(keys[1]).toEqual({ version: 2, key: 'ddeeff' });
  });

  it('rejects empty array', () => {
    expect(() => parseManagedKeys('[]')).toThrow('at least one key');
  });

  it('rejects duplicate versions', () => {
    expect(() => parseManagedKeys('[{"version":1,"key":"aa"},{"version":1,"key":"bb"}]')).toThrow('Duplicate');
  });

  it('rejects non-positive version', () => {
    expect(() => parseManagedKeys('[{"version":0,"key":"aa"}]')).toThrow('positive integer');
  });

  it('rejects negative version', () => {
    expect(() => parseManagedKeys('[{"version":-1,"key":"aa"}]')).toThrow('positive integer');
  });

  it('rejects missing key field', () => {
    expect(() => parseManagedKeys('[{"version":1}]')).toThrow();
  });

  it('rejects non-string key', () => {
    expect(() => parseManagedKeys('[{"version":1,"key":123}]')).toThrow();
  });

  it('rejects non-array JSON', () => {
    expect(() => parseManagedKeys('{"version":1,"key":"aa"}')).toThrow();
  });
});

describe('getManagedKey', () => {
  const keys = [{ version: 1, key: 'key-v1' }, { version: 3, key: 'key-v3' }];

  it('returns correct key for version', () => {
    expect(getManagedKey(keys, 1)).toBe('key-v1');
    expect(getManagedKey(keys, 3)).toBe('key-v3');
  });

  it('throws for unknown version', () => {
    expect(() => getManagedKey(keys, 2)).toThrow('version 2');
  });
});

describe('getActiveKeyVersion', () => {
  it('returns highest version entry', () => {
    const keys = [{ version: 1, key: 'old' }, { version: 5, key: 'newest' }, { version: 3, key: 'mid' }];
    const active = getActiveKeyVersion(keys);
    expect(active).toEqual({ version: 5, key: 'newest' });
  });

  it('works with single entry', () => {
    const keys = [{ version: 1, key: 'only' }];
    expect(getActiveKeyVersion(keys)).toEqual({ version: 1, key: 'only' });
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
