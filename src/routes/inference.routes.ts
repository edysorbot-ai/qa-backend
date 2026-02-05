import { Router } from 'express';
import {
  scanTestResult,
  getInferenceScan,
  getAgentInferenceScans,
  getComplianceSummary,
  acknowledgeInference,
} from '../controllers/inference.controller';

const router = Router();

/**
 * @swagger
 * /api/test-results/{resultId}/scan-inferences:
 *   post:
 *     summary: Scan a test result for implicit inferences
 *     tags: [Compliance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: resultId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Scan result
 */
router.post('/test-results/:resultId/scan-inferences', scanTestResult);

/**
 * @swagger
 * /api/test-results/{resultId}/inference-scan:
 *   get:
 *     summary: Get inference scan for a test result
 *     tags: [Compliance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: resultId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Inference scan result
 */
router.get('/test-results/:resultId/inference-scan', getInferenceScan);

/**
 * @swagger
 * /api/agents/{agentId}/inference-scans:
 *   get:
 *     summary: Get all inference scans for an agent
 *     tags: [Compliance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: List of inference scans
 */
router.get('/agents/:agentId/inference-scans', getAgentInferenceScans);

/**
 * @swagger
 * /api/agents/{agentId}/compliance-summary:
 *   get:
 *     summary: Get compliance summary for an agent
 *     tags: [Compliance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Compliance summary with category and risk breakdowns
 */
router.get('/agents/:agentId/compliance-summary', getComplianceSummary);

/**
 * @swagger
 * /api/inferences/{inferenceId}/acknowledge:
 *   post:
 *     summary: Acknowledge an inference (mark as reviewed)
 *     tags: [Compliance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: inferenceId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Inference acknowledged
 */
router.post('/inferences/:inferenceId/acknowledge', acknowledgeInference);

export default router;
