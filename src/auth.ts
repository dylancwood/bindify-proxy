// src/auth.ts
import type { Env } from "./index";
import { generateRandomString, generateCodeChallenge } from "./crypto";
import { log } from "./logger";
import {
  getClientRegistration,
  setClientRegistration,
  setPKCEState,
  getPKCEState,
  setTokenData,
} from "./kv";

const LINEAR_AUTH_BASE = "https://mcp.linear.app";

async function ensureClientRegistration(env: Env, redirectUri: string) {
  const existing = await getClientRegistration(env.KV);
  if (existing) return existing;

  const response = await fetch(`${LINEAR_AUTH_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Bindify MCP Auth Proxy",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "client_secret_post",
      response_types: ["code"],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Client registration failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { client_id: string; client_secret?: string };
  const reg = { client_id: data.client_id, client_secret: data.client_secret };
  await setClientRegistration(env.KV, reg);
  return reg;
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/auth/callback`;

  const client = await ensureClientRegistration(env, redirectUri);
  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateRandomString(32);

  await setPKCEState(env.KV, state, {
    code_verifier: codeVerifier,
    client_id: client.client_id,
  });

  const authUrl = new URL(`${LINEAR_AUTH_BASE}/authorize`);
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  return Response.redirect(authUrl.toString(), 302);
}

export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`OAuth error: ${error}`, { status: 400 });
  }

  if (!code || !state) {
    return new Response("Missing code or state parameter", { status: 400 });
  }

  const pkce = await getPKCEState(env.KV, state);
  if (!pkce) {
    return new Response("Invalid or expired state parameter", { status: 400 });
  }

  const client = await getClientRegistration(env.KV);
  if (!client) {
    return new Response("Client registration not found", { status: 500 });
  }

  const redirectUri = `${url.origin}/auth/callback`;

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: pkce.code_verifier,
  });
  if (client.client_secret) {
    tokenBody.set("client_secret", client.client_secret);
  }

  const tokenResponse = await fetch(`${LINEAR_AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    log.error('Token exchange failed', undefined, {
      handler: 'handleLinearCallback',
      status: tokenResponse.status,
      body: text,
    });
    return new Response('Token exchange failed', { status: 502 });
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const secret = crypto.randomUUID();
  await setTokenData(env.KV, secret, {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + tokenData.expires_in,
  });

  const mcpUrl = `${url.origin}/mcp/${secret}/sse`;

  return new Response(
    `<!DOCTYPE html>
<html><head><title>Bindify - Connected!</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 0 20px;">
  <h1>Connected to Linear!</h1>
  <p>Your MCP proxy URL (paste this into Claude as a remote MCP server):</p>
  <pre style="background: #f0f0f0; padding: 12px; border-radius: 6px; word-break: break-all;">${mcpUrl}</pre>
  <button onclick="navigator.clipboard.writeText('${mcpUrl}')" style="padding: 8px 16px; cursor: pointer;">Copy URL</button>
  <p style="color: #666; font-size: 14px;">Keep this URL secret — anyone with it can access your Linear data through MCP.</p>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
