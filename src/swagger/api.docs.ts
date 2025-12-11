/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Health check endpoint
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */

/**
 * @swagger
 * /api/users/me:
 *   get:
 *     summary: Get current authenticated user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *   put:
 *     summary: Update current user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateUserRequest'
 *     responses:
 *       200:
 *         description: User updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: User not found
 */

/**
 * @swagger
 * /api/integrations:
 *   get:
 *     summary: Get all integrations for current user
 *     tags: [Integrations]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of integrations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 integrations:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Integration'
 *       401:
 *         description: Unauthorized
 *   post:
 *     summary: Create a new integration (add API key)
 *     tags: [Integrations]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateIntegrationRequest'
 *           example:
 *             provider: elevenlabs
 *             api_key: sk-xxxxxxxxxxxxxxxxxxxxx
 *     responses:
 *       201:
 *         description: Integration created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 integration:
 *                   $ref: '#/components/schemas/Integration'
 *       400:
 *         description: Invalid request or API key
 *       401:
 *         description: Unauthorized
 *
 * /api/integrations/{id}:
 *   get:
 *     summary: Get integration by ID
 *     tags: [Integrations]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Integration ID
 *     responses:
 *       200:
 *         description: Integration details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 integration:
 *                   $ref: '#/components/schemas/Integration'
 *       404:
 *         description: Integration not found
 *   put:
 *     summary: Update integration
 *     tags: [Integrations]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateIntegrationRequest'
 *     responses:
 *       200:
 *         description: Integration updated
 *       404:
 *         description: Integration not found
 *   delete:
 *     summary: Delete integration
 *     tags: [Integrations]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Integration deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Integration not found
 */

/**
 * @swagger
 * /api/agents:
 *   get:
 *     summary: Get all agents for current user
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of agents
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 agents:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Agent'
 *   post:
 *     summary: Create a new agent
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateAgentRequest'
 *           example:
 *             integration_id: 550e8400-e29b-41d4-a716-446655440000
 *             name: Customer Support Agent
 *             provider: elevenlabs
 *             prompt: You are a helpful customer support agent for Acme Inc.
 *             intents:
 *               - greeting
 *               - booking
 *               - complaint
 *               - farewell
 *             config:
 *               voice: rachel
 *               model: gpt-4
 *     responses:
 *       201:
 *         description: Agent created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 agent:
 *                   $ref: '#/components/schemas/Agent'
 *       400:
 *         description: Invalid request
 *
 * /api/agents/{id}:
 *   get:
 *     summary: Get agent by ID with stats
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Agent details with test count and last run
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 agent:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Agent'
 *                     - type: object
 *                       properties:
 *                         test_count:
 *                           type: integer
 *                         last_run:
 *                           type: string
 *                           format: date-time
 *       404:
 *         description: Agent not found
 *   put:
 *     summary: Update agent
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateAgentRequest'
 *     responses:
 *       200:
 *         description: Agent updated
 *       404:
 *         description: Agent not found
 *   delete:
 *     summary: Delete agent
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Agent deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Agent not found
 */

/**
 * @swagger
 * /api/test-cases:
 *   get:
 *     summary: Get all test cases
 *     tags: [Test Cases]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: agent_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by agent ID
 *     responses:
 *       200:
 *         description: List of test cases
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 testCases:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/TestCase'
 *   post:
 *     summary: Create a new test case
 *     tags: [Test Cases]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateTestCaseRequest'
 *           example:
 *             agent_id: 550e8400-e29b-41d4-a716-446655440000
 *             name: Booking Intent Test
 *             description: Test if agent correctly handles booking requests
 *             user_input: I would like to book an appointment for tomorrow at 3pm
 *             expected_intent: booking
 *             expected_output: I can help you book an appointment
 *             variations:
 *               - input: Can I schedule a meeting tomorrow?
 *                 type: paraphrase
 *               - input: Book appointment tmrw 3pm
 *                 type: edge_case
 *     responses:
 *       201:
 *         description: Test case created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 testCase:
 *                   $ref: '#/components/schemas/TestCase'
 *
 * /api/test-cases/bulk:
 *   post:
 *     summary: Create multiple test cases at once
 *     tags: [Test Cases]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/BulkCreateTestCasesRequest'
 *     responses:
 *       201:
 *         description: Test cases created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 testCases:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/TestCase'
 *
 * /api/test-cases/{id}:
 *   get:
 *     summary: Get test case by ID
 *     tags: [Test Cases]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Test case details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 testCase:
 *                   $ref: '#/components/schemas/TestCase'
 *       404:
 *         description: Test case not found
 *   put:
 *     summary: Update test case
 *     tags: [Test Cases]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateTestCaseRequest'
 *     responses:
 *       200:
 *         description: Test case updated
 *       404:
 *         description: Test case not found
 *   delete:
 *     summary: Delete test case
 *     tags: [Test Cases]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Test case deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Test case not found
 */

/**
 * @swagger
 * /api/test-runs:
 *   get:
 *     summary: Get all test runs
 *     tags: [Test Runs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: agent_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by agent ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of results to return
 *     responses:
 *       200:
 *         description: List of test runs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 testRuns:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/TestRun'
 *   post:
 *     summary: Create a new test run
 *     tags: [Test Runs]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateTestRunRequest'
 *           example:
 *             agent_id: 550e8400-e29b-41d4-a716-446655440000
 *             name: Nightly Regression Test
 *             config:
 *               tts_provider: elevenlabs
 *               tts_voice: rachel
 *               parallel_execution: true
 *               max_concurrent: 5
 *               timeout_ms: 30000
 *     responses:
 *       201:
 *         description: Test run created with results initialized
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 testRun:
 *                   $ref: '#/components/schemas/TestRun'
 *                 results:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/TestResult'
 *
 * /api/test-runs/stats:
 *   get:
 *     summary: Get test run statistics for current user
 *     tags: [Test Runs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Test run statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 stats:
 *                   $ref: '#/components/schemas/TestRunStats'
 *
 * /api/test-runs/{id}:
 *   get:
 *     summary: Get test run by ID with all results
 *     tags: [Test Runs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Test run with results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 testRun:
 *                   allOf:
 *                     - $ref: '#/components/schemas/TestRun'
 *                     - type: object
 *                       properties:
 *                         results:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/TestResult'
 *       404:
 *         description: Test run not found
 *   delete:
 *     summary: Delete test run
 *     tags: [Test Runs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Test run deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Test run not found
 *
 * /api/test-runs/{id}/start:
 *   post:
 *     summary: Start test run execution
 *     tags: [Test Runs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Test run started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 testRun:
 *                   $ref: '#/components/schemas/TestRun'
 *                 message:
 *                   type: string
 *                   example: Test run started
 *       404:
 *         description: Test run not found
 *
 * /api/test-runs/{id}/cancel:
 *   post:
 *     summary: Cancel test run
 *     tags: [Test Runs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Test run cancelled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 testRun:
 *                   $ref: '#/components/schemas/TestRun'
 *                 message:
 *                   type: string
 *                   example: Test run cancelled
 *       404:
 *         description: Test run not found
 */

export {};
