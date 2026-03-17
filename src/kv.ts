// src/kv.ts

export interface ClientRegistration {
  client_id: string;
  client_secret?: string;
}

export interface PKCEState {
  code_verifier: string;
  client_id: string;
}

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in seconds
}

const CLIENT_KEY = "client:registration";

export async function getClientRegistration(kv: KVNamespace): Promise<ClientRegistration | null> {
  const data = await kv.get(CLIENT_KEY);
  return data ? JSON.parse(data) : null;
}

export async function setClientRegistration(kv: KVNamespace, reg: ClientRegistration): Promise<void> {
  await kv.put(CLIENT_KEY, JSON.stringify(reg));
}

export async function getPKCEState(kv: KVNamespace, state: string): Promise<PKCEState | null> {
  const data = await kv.get(`pkce:${state}`);
  return data ? JSON.parse(data) : null;
}

export async function setPKCEState(kv: KVNamespace, state: string, pkce: PKCEState): Promise<void> {
  await kv.put(`pkce:${state}`, JSON.stringify(pkce), { expirationTtl: 600 });
}

export async function getTokenData(kv: KVNamespace, secret: string): Promise<TokenData | null> {
  const data = await kv.get(`session:${secret}`);
  return data ? JSON.parse(data) : null;
}

export async function setTokenData(kv: KVNamespace, secret: string, tokens: TokenData): Promise<void> {
  await kv.put(`session:${secret}`, JSON.stringify(tokens));
}
