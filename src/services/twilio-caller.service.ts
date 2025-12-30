/**
 * Twilio Phone Caller Service
 * Makes real phone calls to voice agents using Twilio
 * Used for testing VAPI and Haptik agents via their phone numbers
 */

import Twilio from 'twilio';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { TTSService } from './tts.service';
import OpenAI from 'openai';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;  // Your Twilio phone number
}

export interface PhoneCallConfig {
  toNumber: string;        // Agent's phone number to call
  provider: 'vapi' | 'haptik';
  agentId: string;
  apiKey: string;
}

export interface CallTranscriptTurn {
  role: 'test_caller' | 'ai_agent';
  content: string;
  timestamp: number;
}

/**
 * Twilio Phone Caller - Makes actual phone calls to voice agents
 */
export class TwilioPhoneCallerService extends EventEmitter {
  private twilioClient: Twilio.Twilio;
  private config: TwilioConfig;
  private ttsService: TTSService;
  private openai: OpenAI;

  constructor() {
    super();
    
    // Initialize Twilio client from environment
    this.config = {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      fromNumber: process.env.TWILIO_PHONE_NUMBER || '',
    };

    if (!this.config.accountSid || !this.config.authToken) {
      console.warn('[TwilioCaller] Missing Twilio credentials - phone calling disabled');
    }

    this.twilioClient = Twilio(this.config.accountSid, this.config.authToken);
    this.ttsService = new TTSService(process.env.ELEVENLABS_API_KEY || '');
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  /**
   * Check if Twilio is properly configured
   */
  isConfigured(): boolean {
    return !!(this.config.accountSid && this.config.authToken && this.config.fromNumber);
  }

  /**
   * Make a phone call to a voice agent and conduct a test conversation
   */
  async makeTestCall(
    phoneNumber: string,
    testScenarios: Array<{ id: string; name: string; scenario: string; userInput: string }>,
    systemPrompt: string
  ): Promise<{
    success: boolean;
    callSid?: string;
    transcript: CallTranscriptTurn[];
    durationMs: number;
    recordingUrl?: string;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return {
        success: false,
        transcript: [],
        durationMs: 0,
        error: 'Twilio not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to .env'
      };
    }

    const startTime = Date.now();
    const transcript: CallTranscriptTurn[] = [];

    try {
      console.log(`[TwilioCaller] Initiating call to ${phoneNumber}`);
      
      // Create a TwiML bin URL or use Twilio Studio for the call flow
      // For now, we'll use a simple approach with media streams
      
      // Create the outbound call with recording and media stream
      const call = await this.twilioClient.calls.create({
        to: phoneNumber,
        from: this.config.fromNumber,
        record: true,
        recordingStatusCallback: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/twilio/recording-status`,
        statusCallback: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/twilio/call-status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        twiml: this.buildTwiML(systemPrompt, testScenarios),
      });

      console.log(`[TwilioCaller] Call initiated: ${call.sid}`);

      // Wait for call to complete (with timeout)
      const callResult = await this.waitForCallCompletion(call.sid, 300000); // 5 min timeout
      
      // Fetch recording if available
      let recordingUrl: string | undefined;
      try {
        const recordings = await this.twilioClient.recordings.list({
          callSid: call.sid,
          limit: 1
        });
        if (recordings.length > 0) {
          recordingUrl = `https://api.twilio.com${recordings[0].uri.replace('.json', '.mp3')}`;
        }
      } catch (e) {
        console.error('[TwilioCaller] Error fetching recording:', e);
      }

      return {
        success: callResult.status === 'completed',
        callSid: call.sid,
        transcript,
        durationMs: Date.now() - startTime,
        recordingUrl,
      };

    } catch (error) {
      console.error('[TwilioCaller] Error making call:', error);
      return {
        success: false,
        transcript,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Build TwiML for the test call with media streams
   */
  private buildTwiML(systemPrompt: string, scenarios: Array<{ name: string; userInput: string }>): string {
    // For a real implementation, you'd use Twilio Media Streams
    // to stream audio and handle bidirectional conversation
    // This is a simplified version that uses <Say> and <Gather>
    
    const scenarioText = scenarios.map(s => s.userInput).join('. Then say: ');
    
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="2"/>
  <Say voice="Polly.Matthew">Hello?</Say>
  <Gather input="speech" timeout="10" speechTimeout="auto" action="${process.env.BACKEND_URL || 'http://localhost:5000'}/api/twilio/gather" method="POST">
    <Say voice="Polly.Matthew">I'm calling to inquire about your services.</Say>
  </Gather>
  <Say voice="Polly.Matthew">I didn't catch that. Goodbye.</Say>
</Response>`;
  }

  /**
   * Wait for call to complete
   */
  private async waitForCallCompletion(
    callSid: string,
    timeoutMs: number
  ): Promise<{ status: string; duration: number }> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const call = await this.twilioClient.calls(callSid).fetch();
      
      if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(call.status)) {
        return {
          status: call.status,
          duration: parseInt(call.duration || '0') * 1000,
        };
      }
      
      // Wait 2 seconds before checking again
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Timeout - cancel the call
    await this.twilioClient.calls(callSid).update({ status: 'canceled' });
    return { status: 'timeout', duration: timeoutMs };
  }

  /**
   * Make a test call using Twilio Media Streams for real-time audio
   * This is the advanced implementation with bidirectional audio
   */
  async makeMediaStreamCall(
    phoneNumber: string,
    testScenarios: Array<{ id: string; name: string; scenario: string; userInput: string }>,
    systemPrompt: string,
    webhookBaseUrl: string
  ): Promise<{
    success: boolean;
    callSid?: string;
    transcript: CallTranscriptTurn[];
    durationMs: number;
    recordingUrl?: string;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return {
        success: false,
        transcript: [],
        durationMs: 0,
        error: 'Twilio not configured'
      };
    }

    const startTime = Date.now();
    const transcript: CallTranscriptTurn[] = [];

    try {
      console.log(`[TwilioCaller] Initiating media stream call to ${phoneNumber}`);

      // Create call with Media Streams TwiML
      const call = await this.twilioClient.calls.create({
        to: phoneNumber,
        from: this.config.fromNumber,
        record: true,
        twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${webhookBaseUrl}/api/twilio/media-stream" />
  </Connect>
</Response>`,
      });

      console.log(`[TwilioCaller] Media stream call initiated: ${call.sid}`);

      // The actual conversation will be handled via WebSocket media streams
      // Store the call SID for the WebSocket handler to use
      this.emit('call_started', { callSid: call.sid, scenarios: testScenarios, systemPrompt });

      // Wait for call completion
      const callResult = await this.waitForCallCompletion(call.sid, 300000);

      return {
        success: callResult.status === 'completed',
        callSid: call.sid,
        transcript,
        durationMs: Date.now() - startTime,
      };

    } catch (error) {
      console.error('[TwilioCaller] Media stream call error:', error);
      return {
        success: false,
        transcript,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get call details including transcript
   */
  async getCallDetails(callSid: string): Promise<{
    status: string;
    duration: number;
    from: string;
    to: string;
    recordingUrl?: string;
  } | null> {
    try {
      const call = await this.twilioClient.calls(callSid).fetch();
      
      let recordingUrl: string | undefined;
      const recordings = await this.twilioClient.recordings.list({ callSid, limit: 1 });
      if (recordings.length > 0) {
        recordingUrl = `https://api.twilio.com${recordings[0].uri.replace('.json', '.mp3')}`;
      }

      return {
        status: call.status,
        duration: parseInt(call.duration || '0'),
        from: call.from,
        to: call.to,
        recordingUrl,
      };
    } catch (error) {
      console.error('[TwilioCaller] Error getting call details:', error);
      return null;
    }
  }
}

// Singleton instance
export const twilioCallerService = new TwilioPhoneCallerService();
