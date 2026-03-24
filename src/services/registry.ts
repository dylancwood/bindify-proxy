import type { ServiceId } from '@bindify/types';
import type { ServiceDefinition } from './types';
import { linear } from './linear';
import { todoist } from './todoist';
import { atlassian } from './atlassian';
import { notion } from './notion';
import { github } from './github';
import { figma } from './figma';
import { ticktick } from './ticktick';

const services: Record<string, ServiceDefinition> = { linear, todoist, atlassian, notion, github, figma, ticktick };

export function getService(id: ServiceId | string): ServiceDefinition | null {
  return services[id] ?? null;
}

export function getAllServices(): ServiceDefinition[] {
  return Object.values(services);
}
