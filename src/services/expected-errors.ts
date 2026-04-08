import { getService } from './registry';

interface EventInfo {
  category: string;
  detail?: string;
  upstreamStatus?: number;
}

export function resolveEventCategory(event: EventInfo, service: string): string {
  const serviceDef = getService(service);
  const expected = serviceDef?.config.expectedErrors;
  if (!expected) return event.category;

  if (
    expected.keepaliveSessionIdMissing &&
    event.category === 'transient_error' &&
    event.detail?.includes('No MCP session ID')
  ) {
    return 'expected';
  }

  if (
    expected.httpGetNotSupported &&
    event.category === 'upstream_error' &&
    event.upstreamStatus === 405
  ) {
    return 'expected';
  }

  return event.category;
}
