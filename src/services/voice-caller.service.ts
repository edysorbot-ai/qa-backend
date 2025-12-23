/**
 * Voice Agent Caller Service
 * Handles making calls to voice agents (ElevenLabs, Retell, VAPI)
 * Supports WebSocket streaming and REST API calls
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface CallConfig {
  provider: 'elevenlabs' | 'retell' | 'vapi' | 'haptik';
  agentId: string;
  apiKey: string;
  timeout?: number;
}

export interface ConversationTurn {
  role: 'user' | 'agent';
  text: string;
  audioBuffer?: Buffer;
  startTime: number;
  endTime: number;
  latencyMs?: number;
}

export interface CallResult {
  success: boolean;
  conversationId?: string;
  turns: ConversationTurn[];
  totalDurationMs: number;
  metrics: {
    firstResponseLatencyMs?: number;
    avgResponseLatencyMs?: number;
    totalTurns: number;
  };
  error?: string;
  rawResponse?: any;
}

/**
 * ElevenLabs Conversational AI Caller
 */
export class ElevenLabsCaller extends EventEmitter {
  private apiKey: string;
  private ws: WebSocket | null = null;
  private conversationId: string | null = null;
  private turns: ConversationTurn[] = [];
  private startTime: number = 0;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  /**
   * Start a conversation with an ElevenLabs agent
   */
  async startConversation(agentId: string): Promise<{ conversationId: string; ws: WebSocket }> {
    // Get signed URL for WebSocket connection
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      {
        method: 'GET',
        headers: {
          'xi-api-key': this.apiKey,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${await response.text()}`);
    }

    const responseData = await response.json() as { signed_url: string };
    const { signed_url } = responseData;
    
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(signed_url);
      this.startTime = Date.now();

      this.ws.on('open', () => {
        console.log('ElevenLabs WebSocket connected');
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
          
          if (message.type === 'conversation_initiation_metadata') {
            this.conversationId = message.conversation_id;
            resolve({ conversationId: message.conversation_id, ws: this.ws! });
          }
        } catch (e) {
          // Binary audio data
          this.emit('audio', data);
        }
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });

      this.ws.on('close', () => {
        this.emit('close');
      });
    });
  }

  private handleMessage(message: any) {
    switch (message.type) {
      case 'agent_response':
        this.emit('agent_response', message);
        break;
      case 'user_transcript':
        this.emit('user_transcript', message);
        break;
      case 'audio':
        this.emit('agent_audio', message);
        break;
      case 'interruption':
        this.emit('interruption', message);
        break;
      case 'ping':
        this.sendPong(message.event_id);
        break;
    }
  }

  /**
   * Send user audio to the agent
   */
  sendAudio(audioBuffer: Buffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send as base64 encoded audio
      const base64Audio = audioBuffer.toString('base64');
      this.ws.send(JSON.stringify({
        user_audio_chunk: base64Audio,
      }));
    }
  }

  /**
   * Send text input (for testing without TTS)
   */
  sendText(text: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'user_message',
        text: text,
      }));
    }
  }

  private sendPong(eventId: number) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'pong',
        event_id: eventId,
      }));
    }
  }

  /**
   * End the conversation
   */
  endConversation() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getTurns(): ConversationTurn[] {
    return this.turns;
  }

  getDuration(): number {
    return Date.now() - this.startTime;
  }
}

/**
 * Retell AI Caller
 */
export class RetellCaller extends EventEmitter {
  private apiKey: string;
  private ws: WebSocket | null = null;
  private callId: string | null = null;
  private startTime: number = 0;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  /**
   * Create a web call with Retell
   */
  async createWebCall(agentId: string): Promise<{ callId: string; accessToken: string }> {
    const response = await fetch('https://api.retellai.com/v2/create-web-call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: agentId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create Retell call: ${await response.text()}`);
    }

    const data = await response.json() as { call_id: string; access_token: string };
    this.callId = data.call_id;
    this.startTime = Date.now();

    return {
      callId: data.call_id,
      accessToken: data.access_token,
    };
  }

  /**
   * Connect to Retell WebSocket for audio streaming
   */
  async connectWebSocket(accessToken: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        `wss://api.retellai.com/audio-websocket/${accessToken}`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
          },
        }
      );

      this.ws.on('open', () => {
        console.log('Retell WebSocket connected');
        resolve(this.ws!);
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('error', reject);
      this.ws.on('close', () => this.emit('close'));
    });
  }

  private handleMessage(data: Buffer) {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.response_type === 'audio') {
        this.emit('agent_audio', Buffer.from(message.audio, 'base64'));
      } else if (message.response_type === 'transcript') {
        this.emit('transcript', message);
      }
    } catch {
      // Binary audio data
      this.emit('audio', data);
    }
  }

  sendAudio(audioBuffer: Buffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(audioBuffer);
    }
  }

  endCall() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getDuration(): number {
    return Date.now() - this.startTime;
  }
}

/**
 * VAPI Caller
 */
export class VAPICaller extends EventEmitter {
  private apiKey: string;
  private ws: WebSocket | null = null;
  private callId: string | null = null;
  private startTime: number = 0;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  /**
   * Create a web call with VAPI
   */
  async createCall(assistantId: string): Promise<{ callId: string; webCallUrl: string }> {
    const response = await fetch('https://api.vapi.ai/call/web', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assistantId: assistantId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create VAPI call: ${await response.text()}`);
    }

    const data = await response.json() as { id: string; webCallUrl: string };
    this.callId = data.id;
    this.startTime = Date.now();

    return {
      callId: data.id,
      webCallUrl: data.webCallUrl,
    };
  }

  /**
   * End the VAPI call
   */
  async endCall(): Promise<void> {
    if (this.callId) {
      await fetch(`https://api.vapi.ai/call/${this.callId}/stop`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getDuration(): number {
    return Date.now() - this.startTime;
  }
}

/**
 * Factory function to create the appropriate caller based on provider
 */
export function createCaller(
  provider: 'elevenlabs' | 'retell' | 'vapi' | 'haptik',
  apiKey: string
): ElevenLabsCaller | RetellCaller | VAPICaller | HaptikCaller {
  switch (provider) {
    case 'elevenlabs':
      return new ElevenLabsCaller(apiKey);
    case 'retell':
      return new RetellCaller(apiKey);
    case 'vapi':
      return new VAPICaller(apiKey);
    case 'haptik':
      return new HaptikCaller(apiKey);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Haptik Caller
 * Handles voice calls with Haptik conversational AI platform
 */
export class HaptikCaller extends EventEmitter {
  private apiKey: string;
  private ws: WebSocket | null = null;
  private callId: string | null = null;
  private sessionId: string | null = null;
  private startTime: number = 0;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  /**
   * Create a web call with Haptik
   */
  async createCall(botId: string): Promise<{ callId: string; webSocketUrl?: string; sessionId: string }> {
    const response = await fetch('https://api.haptik.ai/v1/bots/' + botId + '/voice/call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Haptik-Client': 'qa-platform',
      },
      body: JSON.stringify({
        channel: 'web',
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create Haptik call: ${await response.text()}`);
    }

    const data = await response.json() as { call_id: string; websocket_url?: string; session_id: string };
    this.callId = data.call_id;
    this.sessionId = data.session_id;
    this.startTime = Date.now();

    return {
      callId: data.call_id,
      webSocketUrl: data.websocket_url,
      sessionId: data.session_id,
    };
  }

  /**
   * Connect to Haptik WebSocket for real-time voice streaming
   */
  async connectWebSocket(webSocketUrl: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(webSocketUrl, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      this.ws.on('open', () => {
        console.log('Haptik WebSocket connected');
        resolve(this.ws!);
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('error', reject);
      this.ws.on('close', () => this.emit('close'));
    });
  }

  private handleMessage(data: Buffer) {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'bot_response':
          this.emit('bot_response', message);
          break;
        case 'audio':
          this.emit('agent_audio', Buffer.from(message.audio, 'base64'));
          break;
        case 'transcript':
          this.emit('transcript', message);
          break;
        case 'intent_detected':
          this.emit('intent_detected', message);
          break;
        case 'error':
          this.emit('error', new Error(message.error));
          break;
      }
    } catch {
      // Binary audio data
      this.emit('audio', data);
    }
  }

  /**
   * Send audio to the bot
   */
  sendAudio(audioBuffer: Buffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'audio',
        audio: audioBuffer.toString('base64'),
      }));
    }
  }

  /**
   * Send text message to the bot (for text-based testing)
   */
  async sendMessage(botId: string, message: string): Promise<{
    response: string;
    intent?: string;
    confidence?: number;
  } | null> {
    try {
      const response = await fetch(`https://api.haptik.ai/v1/bots/${botId}/message`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Haptik-Client': 'qa-platform',
        },
        body: JSON.stringify({
          message,
          session_id: this.sessionId,
          channel: 'api',
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to send message: ${await response.text()}`);
      }

      const data = await response.json() as {
        response: string;
        intent?: string;
        confidence?: number;
      };

      return data;
    } catch (error) {
      console.error('Error sending message to Haptik:', error);
      return null;
    }
  }

  /**
   * Get call transcript after the call ends
   */
  async getTranscript(): Promise<{
    transcript: string;
    turns: Array<{ role: 'user' | 'bot'; text: string; timestamp: string }>;
    duration: number;
  } | null> {
    if (!this.callId) return null;

    try {
      const response = await fetch(`https://api.haptik.ai/v1/voice/calls/${this.callId}/transcript`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Haptik-Client': 'qa-platform',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get transcript: ${await response.text()}`);
      }

      return await response.json() as {
        transcript: string;
        turns: Array<{ role: 'user' | 'bot'; text: string; timestamp: string }>;
        duration: number;
      };
    } catch (error) {
      console.error('Error getting Haptik transcript:', error);
      return null;
    }
  }

  /**
   * End the call
   */
  async endCall(): Promise<void> {
    if (this.callId) {
      try {
        await fetch(`https://api.haptik.ai/v1/voice/calls/${this.callId}/end`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'X-Haptik-Client': 'qa-platform',
          },
        });
      } catch (error) {
        console.error('Error ending Haptik call:', error);
      }
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getCallId(): string | null {
    return this.callId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getDuration(): number {
    return Date.now() - this.startTime;
  }
}
