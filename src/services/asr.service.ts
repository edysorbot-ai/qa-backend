/**
 * ASR Service - Automatic Speech Recognition for transcribing audio
 * Supports Deepgram for high-accuracy transcription
 */

import { createClient, DeepgramClient } from '@deepgram/sdk';

export interface TranscriptionRequest {
  audioBuffer: Buffer;
  mimeType?: string;
  language?: string;
  model?: string;
}

export interface TranscriptionResponse {
  transcript: string;
  confidence: number;
  words: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
  }>;
  durationMs: number;
  channels: number;
}

export class ASRService {
  private client: DeepgramClient;

  constructor(apiKey: string) {
    this.client = createClient(apiKey);
  }

  /**
   * Transcribe audio buffer to text using Deepgram
   */
  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse> {
    const { audioBuffer, mimeType = 'audio/mpeg', language = 'en', model = 'nova-2' } = request;

    try {
      const { result, error } = await this.client.listen.prerecorded.transcribeFile(
        audioBuffer,
        {
          mimetype: mimeType,
          model: model,
          language: language,
          smart_format: true,
          punctuate: true,
          utterances: true,
          diarize: false,
        }
      );

      if (error) {
        throw new Error(`Deepgram transcription error: ${error.message}`);
      }

      const channel = result.results?.channels?.[0];
      const alternative = channel?.alternatives?.[0];

      if (!alternative) {
        return {
          transcript: '',
          confidence: 0,
          words: [],
          durationMs: 0,
          channels: 1,
        };
      }

      return {
        transcript: alternative.transcript || '',
        confidence: alternative.confidence || 0,
        words: (alternative.words || []).map((w: any) => ({
          word: w.word,
          start: w.start * 1000, // Convert to ms
          end: w.end * 1000,
          confidence: w.confidence,
        })),
        durationMs: (result.metadata?.duration || 0) * 1000,
        channels: result.results?.channels?.length || 1,
      };
    } catch (error) {
      console.error('ASR transcription error:', error);
      throw error;
    }
  }

  /**
   * Transcribe with timing analysis for latency metrics
   */
  async transcribeWithMetrics(
    audioBuffer: Buffer,
    mimeType?: string
  ): Promise<{
    transcription: TranscriptionResponse;
    processingTimeMs: number;
  }> {
    const startTime = Date.now();
    const transcription = await this.transcribe({ audioBuffer, mimeType });
    const processingTimeMs = Date.now() - startTime;

    return {
      transcription,
      processingTimeMs,
    };
  }
}

export const createASRService = (apiKey: string) => new ASRService(apiKey);
