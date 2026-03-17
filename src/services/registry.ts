import type { ServiceId } from '../../../../shared/types';
import type { ServiceDefinition } from './types';
import { linear } from './linear';
import { todoist } from './todoist';
import { atlassian } from './atlassian';
import { notion } from './notion';
import { github } from './github';
import { figma } from './figma';

const services: Record<string, ServiceDefinition> = { linear, todoist, atlassian, notion, github, figma };

export function getService(id: ServiceId | string): ServiceDefinition | null {
  return services[id] ?? null;
}

export function getAllServices(): ServiceDefinition[] {
  return Object.values(services);
}
