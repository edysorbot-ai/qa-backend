/**
 * LiveKit Voice Agent Provider
 * Documentation: https://docs.livekit.io/
 * 
 * LiveKit is a real-time communication platform with built-in agent support.
 * - Uses livekit-server-sdk for Node.js
 * - Authentication: API Key + API Secret
 * - Supports: Room management, agent dispatch, participant management
 * 
 * Note: LiveKit agents are code-based (Python/Node.js), not configuration-based.
 * This provider interfaces with rooms/agents deployed on LiveKit Cloud or self-hosted.
 */

import {
  VoiceProviderClient,
  ProviderValidationResult,
  ProviderLimits,
  VoiceAgent,
} from './provider.interface';

// LiveKit requires both API Key and API Secret
// The API key format is: "api_key:api_secret" or stored as JSON { "apiKey": "...", "apiSecret": "..." }
interface LiveKitCredentials {
  apiKey: string;
  apiSecret: string;
  host: string; // e.g., "https://your-project.livekit.cloud" or self-hosted URL
}

// LiveKit Room structure
interface LiveKitRoom {
  sid: string;
  name: string;
  emptyTimeout: number;
  departureTimeout: number;
  maxParticipants: number;
  creationTime: number;
  turnPassword?: string;
  metadata?: string;
  numParticipants: number;
  activeRecording: boolean;
}

// LiveKit Participant structure
interface LiveKitParticipant {
  sid: string;
  identity: string;
  name?: string;
  state: 'JOINING' | 'JOINED' | 'ACTIVE' | 'DISCONNECTED';
  tracks?: LiveKitTrackInfo[];
  metadata?: string;
  joinedAt: number;
  permission?: LiveKitParticipantPermission;
  isPublisher: boolean;
}

interface LiveKitTrackInfo {
  sid: string;
  type: 'AUDIO' | 'VIDEO' | 'DATA';
  source: 'CAMERA' | 'MICROPHONE' | 'SCREEN_SHARE' | 'SCREEN_SHARE_AUDIO' | 'UNKNOWN';
  name?: string;
  mimeType?: string;
  muted: boolean;
  width?: number;
  height?: number;
  simulcast: boolean;
}

interface LiveKitParticipantPermission {
  canSubscribe: boolean;
  canPublish: boolean;
  canPublishData: boolean;
  canPublishSources?: string[];
  hidden: boolean;
  canUpdateMetadata: boolean;
  canSubscribeMetrics: boolean;
}

// Agent dispatch configuration
interface LiveKitAgentDispatch {
  agentName: string;
  metadata?: string;
}

export class LiveKitProvider implements VoiceProviderClient {
  /**
   * Parse LiveKit credentials from API key string
   * Format can be:
   * 1. "apiKey:apiSecret:host" (colon-separated)
   * 2. JSON: { "apiKey": "...", "apiSecret": "...", "host": "..." }
   * 3. JSON: { "apiKey": "...", "apiSecret": "..." } (host from LIVEKIT_URL env)
   */
  private parseCredentials(apiKeyString: string): LiveKitCredentials {
    // Helper to ensure host has https:// prefix (convert wss:// to https://)
    const normalizeHost = (host: string): string => {
      let trimmed = host.trim();
      // Convert wss:// to https:// for API calls
      if (trimmed.startsWith('wss://')) {
        trimmed = trimmed.replace('wss://', 'https://');
      } else if (trimmed.startsWith('ws://')) {
        trimmed = trimmed.replace('ws://', 'http://');
      } else if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        trimmed = 'https://' + trimmed;
      }
      return trimmed;
    };

    // Get host from environment variable as fallback
    const envHost = process.env.LIVEKIT_URL || '';

    // Try JSON format first
    try {
      const parsed = JSON.parse(apiKeyString);
      if (parsed.apiKey && parsed.apiSecret) {
        // Host can come from JSON or fall back to env variable
        const host = parsed.host || envHost;
        if (!host) {
          throw new Error('LiveKit host URL is required. Set LIVEKIT_URL env variable or provide host in credentials.');
        }
        return {
          apiKey: parsed.apiKey,
          apiSecret: parsed.apiSecret,
          host: normalizeHost(host),
        };
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        // Not JSON, try colon-separated format
      } else {
        throw e;
      }
    }

    // Try colon-separated format: apiKey:apiSecret:host
    const parts = apiKeyString.split(':');
    if (parts.length >= 3) {
      // Last part might have colons (URL with port)
      const apiKey = parts[0];
      const apiSecret = parts[1];
      const host = parts.slice(2).join(':');
      return { apiKey, apiSecret, host: normalizeHost(host) };
    }

    throw new Error('Invalid LiveKit credentials format. Expected JSON or "apiKey:apiSecret:host" format.');
  }

  /**
   * Make a Twirp request to LiveKit API
   * LiveKit uses Twirp protocol (HTTP POST with JSON body)
   */
  private async twirpRequest<T>(
    credentials: LiveKitCredentials,
    service: string,
    method: string,
    body: Record<string, any> = {}
  ): Promise<T> {
    const { AccessToken } = await import('livekit-server-sdk');
    
    // Create access token for server-to-server auth
    const at = new AccessToken(credentials.apiKey, credentials.apiSecret, {
      identity: 'server',
      ttl: 60 * 10, // 10 minutes
    });
    
    // Add admin grants for the specific operation
    at.addGrant({
      roomList: true,
      roomCreate: true,
      roomAdmin: true,
      room: '*',
    });

    const token = await at.toJwt();

    const url = `${credentials.host}/twirp/${service}/${method}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LiveKit API error (${response.status}): ${error}`);
    }

    return response.json() as T;
  }

  /**
   * Use LiveKit server SDK for common operations
   */
  private async getSDKClient(credentials: LiveKitCredentials) {
    const { RoomServiceClient } = await import('livekit-server-sdk');
    return new RoomServiceClient(credentials.host, credentials.apiKey, credentials.apiSecret);
  }

  async validateApiKey(apiKey: string): Promise<ProviderValidationResult> {
    try {
      const credentials = this.parseCredentials(apiKey);
      
      console.log('[LiveKit] Validating credentials for host:', credentials.host);
      
      const roomService = await this.getSDKClient(credentials);
      
      // List rooms to validate the credentials
      const rooms = await roomService.listRooms();

      return {
        valid: true,
        message: 'LiveKit credentials are valid',
        details: {
          accountName: 'LiveKit Account',
          agentsCount: rooms.length, // Rooms can serve as agent containers
          plan: 'Active',
          host: credentials.host,
        },
      };
    } catch (error) {
      console.error('[LiveKit] Validation error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        valid: false,
        message: `Invalid LiveKit credentials: ${message}`,
      };
    }
  }

  async listAgents(apiKey: string): Promise<VoiceAgent[]> {
    try {
      const credentials = this.parseCredentials(apiKey);
      const roomService = await this.getSDKClient(credentials);
      
      // Validate credentials by trying to list rooms
      await roomService.listRooms();
      console.log('[LiveKit] Credentials validated successfully');

      // LiveKit Cloud agents are managed via the cloud dashboard
      // The server SDK doesn't have an API to list deployed agents
      // We provide options for users to connect to their agents
      
      const agents: VoiceAgent[] = [];
      
      // Add a default voice agent option
      // When a room is created, the deployed agent will automatically join
      agents.push({
        id: 'livekit-default-agent',
        name: 'LiveKit Voice Agent',
        provider: 'livekit',
        description: 'Your deployed LiveKit agent will automatically join when a room is created.',
        metadata: {
          type: 'cloud-agent',
          host: credentials.host,
          instructions: 'Make sure your agent is deployed and running in LiveKit Cloud.',
        },
      });

      // Also try to fetch any active rooms with participants (might have agents)
      try {
        const rooms = await roomService.listRooms();
        for (const room of rooms) {
          const r = room as any;
          if (r.numParticipants > 0) {
            agents.push({
              id: `room:${r.name}`,
              name: `Active Room: ${r.name}`,
              provider: 'livekit',
              description: `Room with ${r.numParticipants} participant(s)`,
              metadata: {
                type: 'active-room',
                roomSid: r.sid,
                numParticipants: r.numParticipants,
              },
            });
          }
        }
      } catch (e) {
        console.log('[LiveKit] Could not list rooms:', e);
      }

      return agents;
    } catch (error) {
      console.error('Error with LiveKit credentials:', error);
      return [];
    }
  }

  async getAgent(apiKey: string, agentId: string): Promise<VoiceAgent | null> {
    try {
      const credentials = this.parseCredentials(apiKey);
      const roomService = await this.getSDKClient(credentials);
      
      // Get specific room by name
      const rooms = await roomService.listRooms([agentId]);
      
      if (rooms.length === 0) {
        // Room doesn't exist - this is fine for LiveKit as rooms are created on-demand
        // Return a placeholder agent that can be created
        return {
          id: agentId,
          name: agentId,
          provider: 'livekit',
          description: `LiveKit agent: ${agentId} (will be created on first call)`,
          metadata: {
            roomExists: false,
          },
        };
      }

      const room = rooms[0] as any;
      let agentConfig: any = {};
      let prompt: string | undefined;

      try {
        if (room.metadata) {
          agentConfig = JSON.parse(room.metadata);
          prompt = agentConfig.systemPrompt || agentConfig.prompt;
        }
      } catch {
        // Metadata not JSON
      }

      // Get participants to see if agent is active
      let participants: any[] = [];
      try {
        participants = await roomService.listParticipants(agentId);
      } catch {
        // Room might be empty
      }

      const agentParticipant = participants.find((p: any) => 
        p.identity?.includes('agent') || p.name?.includes('agent')
      );

      return {
        id: room.name,
        name: agentConfig.agentName || room.name,
        provider: 'livekit',
        description: agentConfig.description || `LiveKit room: ${room.name}`,
        voice: agentConfig.voice,
        language: agentConfig.language,
        metadata: {
          roomSid: room.sid,
          roomExists: true,
          numParticipants: room.numParticipants,
          activeRecording: room.activeRecording,
          maxParticipants: room.maxParticipants,
          creationTime: room.creationTime,
          agentActive: !!agentParticipant,
          agentParticipant: agentParticipant ? {
            identity: agentParticipant.identity,
            name: agentParticipant.name,
            state: agentParticipant.state,
          } : null,
          prompt: prompt,
          agentConfig: agentConfig,
        },
      };
    } catch (error) {
      console.error('Error getting LiveKit agent:', error);
      return null;
    }
  }

  async getLimits(apiKey: string): Promise<ProviderLimits> {
    // LiveKit Cloud has project-specific limits
    // Self-hosted has no hard limits (depends on infrastructure)
    return {
      concurrencyLimit: 100, // Default assumption
      source: 'default',
    };
  }

  /**
   * Create a room for agent conversation
   */
  async createRoom(
    apiKey: string,
    roomName: string,
    options?: {
      emptyTimeout?: number;
      maxParticipants?: number;
      metadata?: Record<string, any>;
      agentDispatch?: LiveKitAgentDispatch;
    }
  ): Promise<LiveKitRoom | null> {
    try {
      const credentials = this.parseCredentials(apiKey);
      const roomService = await this.getSDKClient(credentials);

      const roomOptions: any = {
        name: roomName,
        emptyTimeout: options?.emptyTimeout || 300, // 5 minutes default
        maxParticipants: options?.maxParticipants || 10,
      };

      if (options?.metadata) {
        roomOptions.metadata = JSON.stringify(options.metadata);
      }

      const room = await roomService.createRoom(roomOptions);
      return room as any;
    } catch (error) {
      console.error('Error creating LiveKit room:', error);
      return null;
    }
  }

  /**
   * Delete a room
   */
  async deleteRoom(apiKey: string, roomName: string): Promise<boolean> {
    try {
      const credentials = this.parseCredentials(apiKey);
      const roomService = await this.getSDKClient(credentials);
      
      await roomService.deleteRoom(roomName);
      return true;
    } catch (error) {
      console.error('Error deleting LiveKit room:', error);
      return false;
    }
  }

  /**
   * Generate a participant token for joining a room
   */
  async generateParticipantToken(
    apiKey: string,
    roomName: string,
    participantIdentity: string,
    options?: {
      name?: string;
      ttl?: number;
      canPublish?: boolean;
      canSubscribe?: boolean;
      canPublishData?: boolean;
    }
  ): Promise<string> {
    const { AccessToken } = await import('livekit-server-sdk');
    const credentials = this.parseCredentials(apiKey);

    const at = new AccessToken(credentials.apiKey, credentials.apiSecret, {
      identity: participantIdentity,
      name: options?.name,
      ttl: options?.ttl || 60 * 60, // 1 hour default
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: options?.canPublish ?? true,
      canSubscribe: options?.canSubscribe ?? true,
      canPublishData: options?.canPublishData ?? true,
    });

    return at.toJwt();
  }

  /**
   * List participants in a room
   */
  async listParticipants(apiKey: string, roomName: string): Promise<LiveKitParticipant[]> {
    try {
      const credentials = this.parseCredentials(apiKey);
      const roomService = await this.getSDKClient(credentials);
      
      const participants = await roomService.listParticipants(roomName);
      return participants as any[];
    } catch (error) {
      console.error('Error listing LiveKit participants:', error);
      return [];
    }
  }

  /**
   * Remove a participant from a room
   */
  async removeParticipant(apiKey: string, roomName: string, identity: string): Promise<boolean> {
    try {
      const credentials = this.parseCredentials(apiKey);
      const roomService = await this.getSDKClient(credentials);
      
      await roomService.removeParticipant(roomName, identity);
      return true;
    } catch (error) {
      console.error('Error removing LiveKit participant:', error);
      return false;
    }
  }

  /**
   * Send data to participants in a room
   */
  async sendData(
    apiKey: string,
    roomName: string,
    data: Uint8Array | string,
    options?: {
      destinationIdentities?: string[];
      topic?: string;
    }
  ): Promise<boolean> {
    try {
      const credentials = this.parseCredentials(apiKey);
      const roomService = await this.getSDKClient(credentials);
      
      const dataBuffer = typeof data === 'string' 
        ? new TextEncoder().encode(data) 
        : data;

      await roomService.sendData(
        roomName,
        dataBuffer,
        1, // DataPacket_Kind.RELIABLE
        {
          destinationIdentities: options?.destinationIdentities,
          topic: options?.topic,
        }
      );
      return true;
    } catch (error) {
      console.error('Error sending data to LiveKit room:', error);
      return false;
    }
  }

  /**
   * LiveKit doesn't have a direct chat API like other voice AI providers
   * Conversations happen in real-time via WebRTC
   */
  supportsChatTesting(): boolean {
    return false;
  }
}

// Export singleton instance
export const livekitProvider = new LiveKitProvider();
