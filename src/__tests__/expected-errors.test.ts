import { describe, it, expect } from 'vitest';
import { resolveEventCategory } from '../services/expected-errors';

describe('resolveEventCategory', () => {
  it('returns "expected" for Todoist keepalive with missing session ID', () => {
    const result = resolveEventCategory(
      { category: 'transient_error', detail: 'Keep-alive error: No MCP session ID in initialize response' },
      'todoist'
    );
    expect(result).toBe('expected');
  });

  it('returns "transient_error" for GitHub keepalive with missing session ID (no flag)', () => {
    const result = resolveEventCategory(
      { category: 'transient_error', detail: 'Keep-alive error: No MCP session ID in initialize response' },
      'github'
    );
    expect(result).toBe('transient_error');
  });

  it('returns "expected" for Todoist upstream 405', () => {
    const result = resolveEventCategory(
      { category: 'upstream_error', upstreamStatus: 405 },
      'todoist'
    );
    expect(result).toBe('expected');
  });

  it('returns "expected" for GitHub upstream 405', () => {
    const result = resolveEventCategory(
      { category: 'upstream_error', upstreamStatus: 405 },
      'github'
    );
    expect(result).toBe('expected');
  });

  it('returns "upstream_error" for Todoist upstream 502 (not a 405)', () => {
    const result = resolveEventCategory(
      { category: 'upstream_error', upstreamStatus: 502 },
      'todoist'
    );
    expect(result).toBe('upstream_error');
  });

  it('returns original category for unknown service', () => {
    const result = resolveEventCategory(
      { category: 'transient_error', detail: 'Keep-alive error: No MCP session ID in initialize response' },
      'nonexistent'
    );
    expect(result).toBe('transient_error');
  });

  it('returns original category when no detail matches', () => {
    const result = resolveEventCategory(
      { category: 'transient_error', detail: 'Some other error' },
      'todoist'
    );
    expect(result).toBe('transient_error');
  });

  it('returns original category for success events', () => {
    const result = resolveEventCategory(
      { category: 'success' },
      'todoist'
    );
    expect(result).toBe('success');
  });
});
