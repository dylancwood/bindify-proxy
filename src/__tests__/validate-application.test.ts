import { describe, it, expect } from 'vitest';
import { validateApplicationTools } from '../api/validate-application';

describe('validateApplicationTools', () => {
  const mockTools = [
    { name: 'atlassianUserInfo' },
    { name: 'getAccessibleAtlassianResources' },
    { name: 'getJiraIssue' },
    { name: 'editJiraIssue' },
    { name: 'searchConfluenceUsingCql' },
  ];

  it('validates jira when jira tools are present', () => {
    const result = validateApplicationTools('jira', mockTools);
    expect(result.valid).toBe(true);
    expect(result.matchingTools.length).toBeGreaterThan(0);
  });

  it('validates confluence when confluence tools are present', () => {
    const result = validateApplicationTools('confluence', mockTools);
    expect(result.valid).toBe(true);
  });

  it('fails for compass when no compass tools are present', () => {
    const result = validateApplicationTools('compass', mockTools);
    expect(result.valid).toBe(false);
    expect(result.allTools).toHaveLength(5);
  });

  it('always passes for other', () => {
    const result = validateApplicationTools('other', []);
    expect(result.valid).toBe(true);
  });

  it('is case-insensitive', () => {
    const tools = [{ name: 'getJIRAIssue' }];
    const result = validateApplicationTools('jira', tools);
    expect(result.valid).toBe(true);
  });
});
