import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { swaggerSpec } from './config/swagger';
import routes from './routes';
import { clerkAuth, requireAuthentication } from './middleware/auth.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { correlationIdMiddleware } from './middleware/correlationId.middleware';
import { generalRateLimiter } from './middleware/rateLimit.middleware';
import { logger } from './services/logger.service';
import webhookRoutes, { setWebSocketBroadcast } from './routes/webhook.routes';
import monitoringRoutes from './routes/monitoring.routes';
import superadminRoutes from './routes/superadmin.routes';
import adminLogsRoutes from './routes/admin.logs.routes';

const app = express();

// Environment check - disable dev endpoints in production
const isProduction = process.env.NODE_ENV === 'production';

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for Swagger UI
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow cross-origin audio
  crossOriginOpenerPolicy: false,
}));

// CORS configuration
app.use(cors({
  origin: isProduction 
    ? (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)
    : true, // Allow all origins in development
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID', 'X-Request-ID'],
}));

// Correlation ID middleware (adds request tracking)
app.use(correlationIdMiddleware);

// General rate limiting
app.use(generalRateLimiter);

// Request logging (using morgan stream to winston)
app.use(morgan('combined', {
  stream: {
    write: (message: string) => {
      logger.api.info(message.trim());
    },
  },
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Swagger documentation (public)
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  explorer: true,
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Voice Agent QA API Docs',
}));

// Swagger JSON spec
app.get('/api/docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Public audio recordings endpoint (no auth required)
// Serves audio files from recordings directory
// Supports both ulaw raw files (Twilio) and MP3 files (custom agents)
import * as fs from 'fs';
import * as path from 'path';

const recordingsDir = path.join(__dirname, '../recordings');

app.get('/api/audio/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    
    // Sanitize filename to prevent directory traversal
    const sanitizedFilename = path.basename(filename);
    const filePath = path.join(recordingsDir, sanitizedFilename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Audio file not found' });
    }
    
    // Read the audio file
    const audioData = fs.readFileSync(filePath);
    
    // Set CORS headers for cross-origin audio playback
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Accept-Ranges', 'bytes');
    
    // Check if it's an MP3 file by looking at header bytes
    // MP3 files start with 0xFF 0xFB, 0xFF 0xFA, 0xFF 0xF3, 0xFF 0xF2 or ID3 tag
    const isMP3 = (audioData.length > 3) && (
      (audioData[0] === 0xFF && (audioData[1] & 0xE0) === 0xE0) || // MPEG sync word
      (audioData[0] === 0x49 && audioData[1] === 0x44 && audioData[2] === 0x33) // ID3 tag
    );
    
    if (isMP3) {
      // Serve MP3 directly (from ElevenLabs TTS)
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audioData.length);
      res.setHeader('Content-Disposition', `inline; filename="${sanitizedFilename.replace('.raw', '.mp3')}"`);
      res.send(audioData);
    } else {
      // Convert raw ulaw to PCM WAV for browser playback (from Twilio)
      const wavBuffer = createWavFromUlaw(audioData);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', wavBuffer.length);
      res.setHeader('Content-Disposition', `inline; filename="${sanitizedFilename.replace('.raw', '.wav')}"`);
      res.send(wavBuffer);
    }
  } catch (error) {
    logger.api.error('Error serving audio:', { error: error instanceof Error ? error.message : 'Unknown', filename: req.params.filename });
    res.status(500).json({ error: 'Failed to serve audio file' });
  }
});

// Convert ulaw to PCM for better browser compatibility
function createWavFromUlaw(ulawData: Buffer): Buffer {
  const sampleRate = 8000;
  const numChannels = 1;
  
  // Decode ulaw to 16-bit PCM
  const pcmData = Buffer.alloc(ulawData.length * 2);
  for (let i = 0; i < ulawData.length; i++) {
    const pcmSample = ulawToLinear(ulawData[i]);
    pcmData.writeInt16LE(pcmSample, i * 2);
  }
  
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  
  // WAV header is 44 bytes
  const header = Buffer.alloc(44);
  
  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  
  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  
  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);
  
  return Buffer.concat([header, pcmData]);
}

// Ulaw to linear PCM conversion
function ulawToLinear(ulawByte: number): number {
  ulawByte = ~ulawByte;
  const sign = ulawByte & 0x80;
  const exponent = (ulawByte >> 4) & 0x07;
  const mantissa = ulawByte & 0x0F;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

// Clerk authentication middleware
app.use(clerkAuth);

// Public routes (health check)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Public endpoint for enabled integrations (used by frontend settings page)
// Must be before requireAuthentication middleware
app.get('/api/enabled-integrations', async (req, res) => {
  try {
    const { AdminModel } = require('./models/admin.model');
    const integrations = await AdminModel.getEnabledIntegrations();
    res.json(integrations);
  } catch (error) {
    logger.api.error('Error fetching enabled integrations:', { error: error instanceof Error ? error.message : 'Unknown' });
    res.status(500).json({ error: 'Failed to fetch enabled integrations' });
  }
});

// Public webhook routes (no auth - receives callbacks from providers)
app.use('/api/webhooks', webhookRoutes);

// Super admin routes (custom JWT auth, not Clerk)
app.use('/api/superadmin', superadminRoutes);

// Admin logs routes (custom JWT auth)
app.use('/api/admin/logs', adminLogsRoutes);

// Public referral code validation endpoint (for signup page)
app.get('/api/referral/validate/:code', async (req, res) => {
  try {
    const { code } = req.params;
    if (!code) {
      return res.status(400).json({ valid: false, message: 'Referral code is required' });
    }
    
    const { userService } = await import('./services/user.service');
    const result = await userService.validateReferralCode(code);
    
    res.json(result);
  } catch (error) {
    logger.api.error('Validate referral code error:', { error: error instanceof Error ? error.message : 'Unknown' });
    res.status(500).json({ valid: false, message: 'Failed to validate referral code' });
  }
});

// Development test endpoints - ONLY available in non-production environments
// These bypass authentication and should NEVER be enabled in production
if (!isProduction) {
  logger.security.warn('Development endpoints enabled - DO NOT USE IN PRODUCTION');
  
  app.get('/api/dev/agents', async (req, res) => {
    const pool = require('./db').default;
    const result = await pool.query('SELECT * FROM agents LIMIT 10');
    res.json(result.rows);
  });

  app.get('/api/dev/test-cases/:agentId', async (req, res) => {
    const pool = require('./db').default;
    const result = await pool.query('SELECT * FROM test_cases WHERE agent_id = $1', [req.params.agentId]);
    res.json(result.rows);
  });

  app.get('/api/dev/all-test-cases', async (req, res) => {
    const pool = require('./db').default;
    const result = await pool.query('SELECT * FROM test_cases LIMIT 20');
    res.json(result.rows);
  });

  app.get('/api/dev/all-test-runs', async (req, res) => {
    const pool = require('./db').default;
    const result = await pool.query('SELECT * FROM test_runs ORDER BY created_at DESC LIMIT 10');
    res.json(result.rows);
  });

  app.get('/api/dev/all-test-results/:runId', async (req, res) => {
    const pool = require('./db').default;
    const result = await pool.query('SELECT * FROM test_results WHERE test_run_id = $1', [req.params.runId]);
    res.json(result.rows);
  });

  // Get single test result with formatted conversation turns
  app.get('/api/dev/test-result/:resultId', async (req, res) => {
    const pool = require('./db').default;
    const result = await pool.query('SELECT * FROM test_results WHERE id = $1', [req.params.resultId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Result not found' });
    }
    const row = result.rows[0];
    
    // Parse conversation_turns and map text -> content
    let conversationTurns = row.conversation_turns;
    if (typeof conversationTurns === 'string') {
      try {
        conversationTurns = JSON.parse(conversationTurns);
      } catch (e) {
        conversationTurns = [];
      }
    }
    if (Array.isArray(conversationTurns)) {
      conversationTurns = conversationTurns.map((turn: any) => ({
        role: turn.role,
        content: turn.content || turn.text || turn.message || '',
        timestamp: turn.timestamp,
        durationMs: turn.durationMs || turn.latencyMs,
      }));
    }
    
    res.json({
      ...row,
      conversation_turns: conversationTurns,
    });
  });

  // Direct test endpoint - run a single test with ElevenLabs
  app.post('/api/dev/run-test', async (req, res) => {
    logger.api.debug('[DEV] Direct test endpoint called');
    const { agentId, apiKey, testName, scenario, userInput, expectedOutcome, testCase: testCaseParam, useRealAudio } = req.body;
    
    if (!agentId || !apiKey) {
      return res.status(400).json({ error: 'Missing agentId or apiKey' });
    }
    
    const { conversationalTestAgent } = require('./services/conversational-test-agent.service');
    
    // Support both flat parameters and testCase object
    const testCase = testCaseParam ? {
      id: testCaseParam.id || 'dev-test-' + Date.now(),
      name: testCaseParam.name || 'Dev Test',
      scenario: testCaseParam.scenario || 'Test scenario',
      userInput: testCaseParam.userInput || 'Test input',
      expectedOutcome: testCaseParam.expectedOutcome || 'Test outcome',
      category: testCaseParam.category || 'dev',
    } : {
      id: 'dev-test-' + Date.now(),
      name: testName || 'Dev Test',
      scenario: scenario || 'Test scenario',
      userInput: userInput || 'Test input',
      expectedOutcome: expectedOutcome || 'Test outcome',
      category: 'dev',
    };
    
    const agentConfig = {
      provider: 'elevenlabs',
      agentId,
      apiKey,
      useRealAudio: useRealAudio || false,
    };
    
    logger.api.debug('[DEV] Starting test', { 
      agentId: agentConfig.agentId,
      testCase: testCase.name,
      useRealAudio: agentConfig.useRealAudio,
    });
    
    try {
      const result = await conversationalTestAgent.executeConversationalTest(testCase, agentConfig);
      logger.api.debug('[DEV] Test completed', { testCase: testCase.name });
      res.json(result);
    } catch (error: any) {
      logger.api.error('[DEV] Test error:', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  });
} // End of development endpoints block

// Public config routes for custom agents (models/voices list - no auth needed)
import { customProvider } from './providers/custom.provider';

app.get('/api/custom-agents/config/models', async (req, res) => {
  try {
    const models = await customProvider.getAvailableModels();
    res.json(models);
  } catch (error) {
    logger.api.error('Error fetching models:', { error: error instanceof Error ? error.message : 'Unknown' });
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

app.get('/api/custom-agents/config/voices', async (req, res) => {
  try {
    const voices = await customProvider.getAvailableVoices();
    res.json(voices);
  } catch (error) {
    logger.api.error('Error fetching voices:', { error: error instanceof Error ? error.message : 'Unknown' });
    res.status(500).json({ error: 'Failed to fetch voices' });
  }
});

// Protected API routes
app.use('/api', requireAuthentication, routes);

// Protected monitoring routes (needs requireAuthentication for clerk auth)
app.use('/api/monitoring', requireAuthentication, monitoringRoutes);

// 404 handler
app.use(notFoundHandler);

// Error handler
app.use(errorHandler);

export default app;
