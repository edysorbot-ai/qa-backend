/**
 * TTS Service - Text-to-Speech for generating synthetic user voice
 * Supports ElevenLabs TTS for high-quality voice synthesis
 */

export interface TTSRequest {
  text: string;
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  speed?: number;
}

export interface TTSResponse {
  audioBuffer: Buffer;
  format: string;
  durationMs?: number;
}

import { resolveElevenLabsBaseUrl } from '../providers/elevenlabs.provider';

// Default voice IDs for testing (ElevenLabs)
export const DEFAULT_VOICES = {
  male: '29vD33N1CtxCmqQRPOHJ', // Drew
  female: '21m00Tcm4TlvDq8ikWAM', // Rachel
  neutral: 'EXAVITQu4vr4xnSDxMaL', // Bella
};

export class TTSService {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string | null) {
    this.apiKey = apiKey;
    this.baseUrl = resolveElevenLabsBaseUrl(baseUrl);
  }

  /**
   * Generate speech audio from text using ElevenLabs (MP3 format)
   */
  async generateSpeech(request: TTSRequest): Promise<TTSResponse> {
    const voiceId = request.voiceId || DEFAULT_VOICES.neutral;
    const modelId = request.modelId || 'eleven_turbo_v2';

    const response = await fetch(`${this.baseUrl}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: request.text,
        model_id: modelId,
        voice_settings: {
          stability: request.stability ?? 0.5,
          similarity_boost: request.similarityBoost ?? 0.75,
          speed: request.speed ?? 1.0,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`TTS generation failed: ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    // Estimate duration based on text length (rough estimate: 150 words/min)
    const wordCount = request.text.split(/\s+/).length;
    const estimatedDurationMs = (wordCount / 150) * 60 * 1000;

    return {
      audioBuffer,
      format: 'audio/mpeg',
      durationMs: estimatedDurationMs,
    };
  }

  /**
   * Generate speech audio in PCM format for ElevenLabs Conversational AI WebSocket
   * ElevenLabs expects 16kHz mono PCM audio
   */
  async generateSpeechPCM(request: TTSRequest): Promise<TTSResponse> {
    const voiceId = request.voiceId || DEFAULT_VOICES.neutral;
    const modelId = request.modelId || 'eleven_turbo_v2';

    // Request PCM format with specific output format
    const response = await fetch(`${this.baseUrl}/text-to-speech/${voiceId}?output_format=pcm_16000`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: request.text,
        model_id: modelId,
        voice_settings: {
          stability: request.stability ?? 0.5,
          similarity_boost: request.similarityBoost ?? 0.75,
          speed: request.speed ?? 1.0,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`TTS PCM generation failed: ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    // Estimate duration: PCM 16kHz mono = 32000 bytes/second
    const estimatedDurationMs = (audioBuffer.length / 32000) * 1000;

    return {
      audioBuffer,
      format: 'audio/pcm',
      durationMs: estimatedDurationMs,
    };
  }

  /**
   * Generate speech audio in μ-law (ulaw) format for ElevenLabs Conversational AI WebSocket
   * Used when agent expects ulaw_8000 format (common for Twilio integrations)
   */
  async generateSpeechUlaw(request: TTSRequest): Promise<TTSResponse> {
    const voiceId = request.voiceId || DEFAULT_VOICES.neutral;
    const modelId = request.modelId || 'eleven_turbo_v2';

    // Request ulaw format at 8kHz
    const response = await fetch(`${this.baseUrl}/text-to-speech/${voiceId}?output_format=ulaw_8000`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: request.text,
        model_id: modelId,
        voice_settings: {
          stability: request.stability ?? 0.5,
          similarity_boost: request.similarityBoost ?? 0.75,
          speed: request.speed ?? 1.0,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`TTS ulaw generation failed: ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    // Estimate duration: ulaw 8kHz mono = 8000 bytes/second
    const estimatedDurationMs = (audioBuffer.length / 8000) * 1000;

    return {
      audioBuffer,
      format: 'audio/ulaw',
      durationMs: estimatedDurationMs,
    };
  }

  /**
   * Generate speech with variations for testing different accents/speeds
   */
  async generateVariations(
    text: string,
    variations: { voiceId?: string; speed?: number; stability?: number }[]
  ): Promise<TTSResponse[]> {
    const results: TTSResponse[] = [];

    for (const variation of variations) {
      const response = await this.generateSpeech({
        text,
        voiceId: variation.voiceId,
        speed: variation.speed,
        stability: variation.stability,
      });
      results.push(response);
    }

    return results;
  }
}

export const createTTSService = (apiKey: string, baseUrl?: string | null) => new TTSService(apiKey, baseUrl);
