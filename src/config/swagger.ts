import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Voice Agent QA Platform API',
      version: '1.0.0',
      description: 'API documentation for Voice Agent QA Platform - Automated testing for voice agents (ElevenLabs, Retell, VAPI, OpenAI Realtime)',
      contact: {
        name: 'API Support',
      },
    },
    servers: [
      {
        url: 'http://localhost:5000',
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Clerk JWT token',
        },
      },
      schemas: {
        // User schemas
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid', example: '550e8400-e29b-41d4-a716-446655440000' },
            clerk_id: { type: 'string', example: 'user_2abc123def456' },
            email: { type: 'string', format: 'email', example: 'user@example.com' },
            first_name: { type: 'string', example: 'John' },
            last_name: { type: 'string', example: 'Doe' },
            image_url: { type: 'string', format: 'uri', example: 'https://example.com/avatar.jpg' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        UpdateUserRequest: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' },
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            image_url: { type: 'string', format: 'uri' },
          },
        },

        // Integration schemas
        Integration: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            user_id: { type: 'string', format: 'uuid' },
            provider: { type: 'string', enum: ['elevenlabs', 'retell', 'vapi', 'openai_realtime'] },
            api_key: { type: 'string', example: '****abcd' },
            is_active: { type: 'boolean', default: true },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        CreateIntegrationRequest: {
          type: 'object',
          required: ['provider', 'api_key'],
          properties: {
            provider: { 
              type: 'string', 
              enum: ['elevenlabs', 'retell', 'vapi', 'openai_realtime'],
              description: 'Voice agent provider',
              example: 'elevenlabs'
            },
            api_key: { 
              type: 'string', 
              description: 'API key from the provider',
              example: 'sk-xxxxxxxxxxxxx'
            },
          },
        },
        UpdateIntegrationRequest: {
          type: 'object',
          properties: {
            api_key: { type: 'string' },
            is_active: { type: 'boolean' },
          },
        },

        // Agent schemas
        Agent: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            user_id: { type: 'string', format: 'uuid' },
            integration_id: { type: 'string', format: 'uuid' },
            external_agent_id: { type: 'string', example: 'agent_123abc' },
            name: { type: 'string', example: 'Customer Support Agent' },
            provider: { type: 'string', enum: ['elevenlabs', 'retell', 'vapi', 'openai_realtime'] },
            prompt: { type: 'string', example: 'You are a helpful customer support agent...' },
            intents: { 
              type: 'array', 
              items: { type: 'string' },
              example: ['greeting', 'booking', 'complaint', 'farewell']
            },
            config: { 
              type: 'object',
              example: { voice: 'rachel', model: 'gpt-4', temperature: 0.7 }
            },
            status: { type: 'string', enum: ['active', 'inactive', 'error'], default: 'active' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        CreateAgentRequest: {
          type: 'object',
          required: ['integration_id', 'name', 'provider'],
          properties: {
            integration_id: { 
              type: 'string', 
              format: 'uuid',
              description: 'ID of the integration to use'
            },
            external_agent_id: { 
              type: 'string',
              description: 'Agent ID from the provider platform'
            },
            name: { 
              type: 'string',
              description: 'Display name for the agent',
              example: 'Customer Support Bot'
            },
            provider: { 
              type: 'string', 
              enum: ['elevenlabs', 'retell', 'vapi', 'openai_realtime']
            },
            prompt: { 
              type: 'string',
              description: 'System prompt for the agent'
            },
            intents: { 
              type: 'array', 
              items: { type: 'string' },
              description: 'List of intents the agent handles'
            },
            config: { 
              type: 'object',
              description: 'Provider-specific configuration'
            },
          },
        },
        UpdateAgentRequest: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            prompt: { type: 'string' },
            intents: { type: 'array', items: { type: 'string' } },
            config: { type: 'object' },
            status: { type: 'string', enum: ['active', 'inactive', 'error'] },
          },
        },

        // Test Case schemas
        TestCaseVariation: {
          type: 'object',
          properties: {
            input: { type: 'string', example: 'I wanna book an appointment' },
            type: { 
              type: 'string', 
              enum: ['paraphrase', 'accent', 'noise', 'interruption', 'edge_case']
            },
          },
        },
        TestCase: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            agent_id: { type: 'string', format: 'uuid' },
            user_id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Booking Intent Test' },
            description: { type: 'string', example: 'Test if agent correctly handles booking requests' },
            user_input: { type: 'string', example: 'I would like to book an appointment for tomorrow' },
            expected_intent: { type: 'string', example: 'booking' },
            expected_output: { type: 'string', example: 'Sure, I can help you book an appointment' },
            variations: { 
              type: 'array', 
              items: { $ref: '#/components/schemas/TestCaseVariation' }
            },
            config_overrides: { type: 'object' },
            is_auto_generated: { type: 'boolean', default: false },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        CreateTestCaseRequest: {
          type: 'object',
          required: ['agent_id', 'name', 'user_input'],
          properties: {
            agent_id: { 
              type: 'string', 
              format: 'uuid',
              description: 'ID of the agent to test'
            },
            name: { 
              type: 'string',
              description: 'Test case name',
              example: 'Greeting Test'
            },
            description: { type: 'string' },
            user_input: { 
              type: 'string',
              description: 'The user input/utterance to test',
              example: 'Hello, I need help'
            },
            expected_intent: { 
              type: 'string',
              description: 'Expected intent to be detected',
              example: 'greeting'
            },
            expected_output: { 
              type: 'string',
              description: 'Expected agent response (for matching)'
            },
            variations: { 
              type: 'array', 
              items: { $ref: '#/components/schemas/TestCaseVariation' }
            },
            config_overrides: { type: 'object' },
          },
        },
        BulkCreateTestCasesRequest: {
          type: 'object',
          required: ['test_cases'],
          properties: {
            test_cases: {
              type: 'array',
              items: { $ref: '#/components/schemas/CreateTestCaseRequest' },
              minItems: 1,
            },
          },
        },

        // Test Run schemas
        TestRunConfig: {
          type: 'object',
          properties: {
            tts_provider: { type: 'string', example: 'elevenlabs' },
            tts_voice: { type: 'string', example: 'rachel' },
            parallel_execution: { type: 'boolean', default: true },
            max_concurrent: { type: 'integer', default: 5 },
            timeout_ms: { type: 'integer', default: 30000 },
          },
        },
        TestRun: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            user_id: { type: 'string', format: 'uuid' },
            agent_id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Nightly Regression Test' },
            status: { 
              type: 'string', 
              enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
              default: 'pending'
            },
            total_tests: { type: 'integer', default: 0 },
            passed_tests: { type: 'integer', default: 0 },
            failed_tests: { type: 'integer', default: 0 },
            started_at: { type: 'string', format: 'date-time' },
            completed_at: { type: 'string', format: 'date-time' },
            config: { $ref: '#/components/schemas/TestRunConfig' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        CreateTestRunRequest: {
          type: 'object',
          required: ['agent_id'],
          properties: {
            agent_id: { 
              type: 'string', 
              format: 'uuid',
              description: 'ID of the agent to test'
            },
            name: { 
              type: 'string',
              description: 'Name for this test run',
              example: 'Manual Test Run'
            },
            config: { $ref: '#/components/schemas/TestRunConfig' },
            test_case_ids: { 
              type: 'array', 
              items: { type: 'string', format: 'uuid' },
              description: 'Specific test cases to run (optional, runs all if empty)'
            },
          },
        },

        // Test Result schemas
        ConversationTurn: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['user', 'agent'] },
            text: { type: 'string' },
            audio_url: { type: 'string', format: 'uri' },
            timestamp: { type: 'integer' },
            latency_ms: { type: 'integer' },
          },
        },
        TestResultMetrics: {
          type: 'object',
          properties: {
            intent_accuracy: { type: 'number', format: 'float', example: 0.95 },
            script_adherence: { type: 'number', format: 'float', example: 0.88 },
            response_latency_ms: { type: 'integer', example: 450 },
            audio_clarity: { type: 'number', format: 'float' },
            silence_ratio: { type: 'number', format: 'float' },
            overlap_detected: { type: 'boolean' },
            hallucination_detected: { type: 'boolean' },
          },
        },
        TestResult: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            test_run_id: { type: 'string', format: 'uuid' },
            test_case_id: { type: 'string', format: 'uuid' },
            status: { 
              type: 'string', 
              enum: ['pending', 'running', 'passed', 'failed', 'error']
            },
            user_audio_url: { type: 'string', format: 'uri' },
            agent_audio_url: { type: 'string', format: 'uri' },
            user_transcript: { type: 'string' },
            agent_transcript: { type: 'string' },
            detected_intent: { type: 'string' },
            intent_match: { type: 'boolean' },
            output_match: { type: 'boolean' },
            latency_ms: { type: 'integer' },
            conversation_turns: { 
              type: 'array', 
              items: { $ref: '#/components/schemas/ConversationTurn' }
            },
            metrics: { $ref: '#/components/schemas/TestResultMetrics' },
            error_message: { type: 'string' },
            started_at: { type: 'string', format: 'date-time' },
            completed_at: { type: 'string', format: 'date-time' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },

        // Stats schemas
        TestRunStats: {
          type: 'object',
          properties: {
            total_runs: { type: 'integer', example: 50 },
            total_passed: { type: 'integer', example: 420 },
            total_failed: { type: 'integer', example: 30 },
            avg_pass_rate: { type: 'number', format: 'float', example: 93.33 },
          },
        },

        // Common response schemas
        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'error' },
            message: { type: 'string', example: 'Something went wrong' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./src/routes/*.ts', './src/swagger/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
