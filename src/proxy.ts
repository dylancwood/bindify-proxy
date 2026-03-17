import type { Env } from "./index";
import { getTokenData, setTokenData, getClientRegistration } from "./kv";
import type { TokenData } from "./kv";
import { log } from "./logger";

const LINEAR_MCP_BASE = "https://mcp.linear.app";

async function getValidToken(env: Env, secret: string): Promise<TokenData> {
  const tokens = await getTokenData(env.KV, secret);
  if (!tokens) {
    throw new Error("Session not found");
  }

  const now = Math.floor(Date.now() / 1000);
  // Refresh if token expires within 5 minutes
  if (tokens.expires_at - now < 300) {
    const client = await getClientRegistration(env.KV);
    if (!client) throw new Error("Client registration not found");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    if (client.client_secret) {
      body.set("client_secret", client.client_secret);
    }

    const response = await fetch(`${LINEAR_MCP_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const updated: TokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
    };
    await setTokenData(env.KV, secret, updated);
    return updated;
  }

  return tokens;
}

export async function handleSSE(request: Request, env: Env, secret: string): Promise<Response> {
  let tokens: TokenData;
  try {
    tokens = await getValidToken(env, secret);
  } catch {
    return new Response("Unauthorized — please re-authenticate", { status: 401 });
  }

  // Connect to Linear's SSE endpoint
  const upstreamResponse = await fetch(`${LINEAR_MCP_BASE}/sse`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "text/event-stream",
    },
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return new Response(`Upstream error: ${upstreamResponse.status}`, { status: 502 });
  }

  const requestUrl = new URL(request.url);
  const proxyBase = `${requestUrl.origin}/mcp/${secret}`;

  // Create a TransformStream that rewrites the endpoint event
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Process the SSE stream in the background
  const pump = async () => {
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (separated by double newlines)
        const events = buffer.split("\n\n");
        // Keep the last incomplete chunk in the buffer
        buffer = events.pop() || "";

        for (const event of events) {
          if (!event.trim()) continue;

          // Check if this is an endpoint event
          if (event.includes("event: endpoint") || event.includes("event:endpoint")) {
            const dataMatch = event.match(/data:\s*(.+)/);
            const originalData = dataMatch ? dataMatch[1].trim() : "";

            // Parse the upstream message URL and extract sessionId
            // Linear sends: data: /sse/message?sessionId=xxx
            const parsed = new URL(originalData, LINEAR_MCP_BASE);
            const sessionId = parsed.searchParams.get("sessionId") || "";
            const upstreamMessageUrl = parsed.toString();

            // Store the upstream message URL in KV so handleMessages can look it up
            await env.KV.put(`upstream:${sessionId}`, upstreamMessageUrl, { expirationTtl: 3600 });

            // Rewrite the endpoint to point at our proxy, preserving the sessionId
            const rewrittenUrl = `${proxyBase}/messages?sessionId=${sessionId}`;
            const rewritten = event.replace(/data:\s*.+/, `data: ${rewrittenUrl}`);
            await writer.write(encoder.encode(rewritten + "\n\n"));
          } else {
            // Pass through all other events unchanged
            await writer.write(encoder.encode(event + "\n\n"));
          }
        }
      }
    } catch (err) {
      log.error("SSE stream error", err, { handler: 'legacyProxy' });
    } finally {
      try {
        await writer.close();
      } catch {
        // Expected: writer may already be closed if client disconnected
      }
    }
  };

  // Start pumping in the background (don't await)
  pump();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function handleMessages(request: Request, env: Env, secret: string): Promise<Response> {
  let tokens: TokenData;
  try {
    tokens = await getValidToken(env, secret);
  } catch {
    return new Response("Unauthorized — please re-authenticate", { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const sessionId = requestUrl.searchParams.get("sessionId") || "";

  // Look up the actual upstream message URL that Linear gave us during SSE setup
  const upstreamMessageUrl = await env.KV.get(`upstream:${sessionId}`);
  if (!upstreamMessageUrl) {
    return new Response("Session not found — SSE connection may have expired", { status: 404 });
  }

  const body = await request.text();

  const upstreamResponse = await fetch(upstreamMessageUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
    },
    body,
  });

  // Return Linear's response directly to Claude
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
  });
}

export async function handleDebug(request: Request, env: Env, secret: string): Promise<Response> {
  const results: string[] = [];

  let tokens: TokenData;
  try {
    tokens = await getValidToken(env, secret);
    results.push(`Token found: access_token=${tokens.access_token.substring(0, 10)}..., expires_at=${tokens.expires_at}`);
  } catch (err) {
    return new Response(`Token error: ${err}`, { status: 401 });
  }

  results.push(`\nConnecting to ${LINEAR_MCP_BASE}/sse...`);
  const sseResponse = await fetch(`${LINEAR_MCP_BASE}/sse`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "text/event-stream",
    },
  });

  results.push(`SSE response status: ${sseResponse.status}`);

  if (sseResponse.ok && sseResponse.body) {
    const reader = sseResponse.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    for (let i = 0; i < 10; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      if (raw.includes("\n\n")) break;
    }
    reader.cancel();
    results.push(`\nRaw SSE data:\n---\n${raw}\n---`);

    const endpointMatch = raw.match(/data:\s*(.+)/);
    if (endpointMatch) {
      const endpointUrl = endpointMatch[1].trim();
      results.push(`\nEndpoint URL from SSE: "${endpointUrl}"`);
      const messageUrl = endpointUrl.startsWith("http") ? endpointUrl : `${LINEAR_MCP_BASE}${endpointUrl}`;
      results.push(`Full message URL: "${messageUrl}"`);

      const testBody = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bindify-debug", version: "1.0" } },
      });

      const msgResponse = await fetch(messageUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" },
        body: testBody,
      });

      results.push(`Message POST status: ${msgResponse.status}`);
      results.push(`Message POST response: ${(await msgResponse.text()).substring(0, 500)}`);
    }
  }

  return new Response(results.join("\n"), { headers: { "Content-Type": "text/plain" } });
}
