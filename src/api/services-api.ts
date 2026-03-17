import { getAllServices } from '../services/registry';

export function handleListServices(): Response {
  const services = getAllServices().map(svc => ({
    id: svc.config.id,
    name: svc.config.name,
    supportsApiKey: !!svc.config.apiKey,
    apiKeyInstructions: svc.config.apiKey?.instructions ?? null,
    apiKeyFields: svc.config.apiKey?.fields ?? null,
    supportsOAuth: !!svc.config.authorizationUrl,
    requiresRefresh: svc.config.requiresRefresh !== false,
    authModes: svc.config.apiKey?.authModes?.map(m => ({
      id: m.id,
      label: m.label,
      instructions: m.instructions ?? null,
      fields: m.fields ?? null,
    })) ?? null,
    applications: svc.config.apiKey?.applications?.map(a => ({
      id: a.id,
      label: a.label,
    })) ?? null,
  }));

  return Response.json({ services });
}
