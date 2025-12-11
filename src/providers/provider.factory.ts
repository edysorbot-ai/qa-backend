/**
 * Provider Factory - Returns the appropriate provider client based on provider type
 */

import { Provider } from '../models/integration.model';
import { VoiceProviderClient } from './provider.interface';
import { elevenlabsProvider } from './elevenlabs.provider';
import { retellProvider } from './retell.provider';
import { vapiProvider } from './vapi.provider';
import { openaiRealtimeProvider } from './openai-realtime.provider';

export function getProviderClient(provider: Provider): VoiceProviderClient {
  switch (provider) {
    case 'elevenlabs':
      return elevenlabsProvider;
    case 'retell':
      return retellProvider;
    case 'vapi':
      return vapiProvider;
    case 'openai_realtime':
      return openaiRealtimeProvider;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export const providerClients: Record<Provider, VoiceProviderClient> = {
  elevenlabs: elevenlabsProvider,
  retell: retellProvider,
  vapi: vapiProvider,
  openai_realtime: openaiRealtimeProvider,
};
