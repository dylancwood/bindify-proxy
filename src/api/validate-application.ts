export interface ApplicationValidationResult {
  valid: boolean;
  matchingTools: string[];
  allTools: string[];
}

export function validateApplicationTools(
  application: string,
  tools: { name: string }[]
): ApplicationValidationResult {
  const allTools = tools.map(t => t.name);

  // 'other' always passes — no tool validation
  if (application === 'other') {
    return { valid: true, matchingTools: [], allTools };
  }

  const lowerPattern = application.toLowerCase();
  const matchingTools = allTools.filter(name => name.toLowerCase().includes(lowerPattern));

  return {
    valid: matchingTools.length > 0,
    matchingTools,
    allTools,
  };
}

/**
 * Fetch tools from the Atlassian MCP endpoint.
 * Sends initialize to get session ID, then tools/list.
 */
export async function fetchMcpToolsList(
  mcpUrl: string,
  authHeader: string,
  fetchFn: typeof fetch = fetch
): Promise<{ tools: { name: string }[] }> {
  // Step 1: Initialize to get session ID
  const initResponse = await fetchFn(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': authHeader,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'bindify', version: '1.0.0' },
      },
    }),
  });

  if (!initResponse.ok) {
    throw new Error(`MCP initialize failed: ${initResponse.status}`);
  }

  const sessionId = initResponse.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new Error('No MCP session ID in initialize response');
  }

  // Consume the SSE body
  await initResponse.text();

  // Step 2: List tools using session ID
  const toolsResponse = await fetchFn(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': authHeader,
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }),
  });

  if (!toolsResponse.ok) {
    throw new Error(`MCP tools/list failed: ${toolsResponse.status}`);
  }

  const body = await toolsResponse.text();
  const dataLine = body.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) {
    throw new Error('No data in tools/list response');
  }

  const parsed = JSON.parse(dataLine.slice(6));
  return { tools: parsed.result?.tools ?? [] };
}
