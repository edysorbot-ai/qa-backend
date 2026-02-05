import { Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { getInferenceScannerService } from '../services/inference-scanner.service';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';

/**
 * Scan a test result for implicit inferences
 * POST /api/test-results/:resultId/scan-inferences
 */
export async function scanTestResult(req: Request, res: Response, next: NextFunction) {
  try {
    const { resultId } = req.params;
    const clerkUser = (req as any).auth;
    const user = await userService.findOrCreateByClerkId(clerkUser.userId);
    const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

    // Verify test result exists and user has access
    const testResult = await pool.query(
      `SELECT tr.id, trun.agent_id 
       FROM test_results tr
       JOIN test_runs trun ON tr.test_run_id = trun.id
       JOIN agents a ON trun.agent_id = a.id
       WHERE tr.id = $1 AND a.user_id = $2`,
      [resultId, effectiveUserId]
    );

    if (testResult.rows.length === 0) {
      return res.status(404).json({ error: 'Test result not found' });
    }

    const service = getInferenceScannerService(pool);
    const scanResult = await service.scanTestResult(resultId);

    res.json(scanResult);
  } catch (error) {
    console.error('Error scanning test result for inferences', error);
    next(error);
  }
}

/**
 * Get inference scan for a test result
 * GET /api/test-results/:resultId/inference-scan
 */
export async function getInferenceScan(req: Request, res: Response, next: NextFunction) {
  try {
    const { resultId } = req.params;
    const clerkUser = (req as any).auth;
    const user = await userService.findOrCreateByClerkId(clerkUser.userId);
    const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

    // Verify access
    const testResult = await pool.query(
      `SELECT tr.id 
       FROM test_results tr
       JOIN test_runs trun ON tr.test_run_id = trun.id
       JOIN agents a ON trun.agent_id = a.id
       WHERE tr.id = $1 AND a.user_id = $2`,
      [resultId, effectiveUserId]
    );

    if (testResult.rows.length === 0) {
      return res.status(404).json({ error: 'Test result not found' });
    }

    const service = getInferenceScannerService(pool);
    const scanResult = await service.getScanForTestResult(resultId);

    if (!scanResult) {
      return res.status(404).json({ error: 'No inference scan found for this test result' });
    }

    res.json(scanResult);
  } catch (error) {
    console.error('Error getting inference scan', error);
    next(error);
  }
}

/**
 * Get all inference scans for an agent
 * GET /api/agents/:agentId/inference-scans
 */
export async function getAgentInferenceScans(req: Request, res: Response, next: NextFunction) {
  try {
    const { agentId } = req.params;
    const clerkUser = (req as any).auth;
    const user = await userService.findOrCreateByClerkId(clerkUser.userId);
    const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

    // Verify agent access
    const agent = await pool.query(
      `SELECT id FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, effectiveUserId]
    );

    if (agent.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const service = getInferenceScannerService(pool);
    const scans = await service.getScansForAgent(agentId);

    res.json({ scans });
  } catch (error) {
    console.error('Error getting agent inference scans', error);
    next(error);
  }
}

/**
 * Get compliance summary for an agent
 * GET /api/agents/:agentId/compliance-summary
 */
export async function getComplianceSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { agentId } = req.params;
    const clerkUser = (req as any).auth;
    const user = await userService.findOrCreateByClerkId(clerkUser.userId);
    const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

    // Verify agent access
    const agent = await pool.query(
      `SELECT id FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, effectiveUserId]
    );

    if (agent.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const service = getInferenceScannerService(pool);
    const summary = await service.getComplianceSummary(agentId);

    res.json(summary);
  } catch (error) {
    console.error('Error getting compliance summary', error);
    next(error);
  }
}

/**
 * Acknowledge an inference (mark as reviewed)
 * POST /api/inferences/:inferenceId/acknowledge
 */
export async function acknowledgeInference(req: Request, res: Response, next: NextFunction) {
  try {
    const { inferenceId } = req.params;
    const clerkUser = (req as any).auth;
    const user = await userService.findOrCreateByClerkId(clerkUser.userId);
    const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

    // Verify inference exists and user has access
    const inference = await pool.query(
      `SELECT di.id 
       FROM detected_inferences di
       JOIN inference_scans is2 ON di.scan_id = is2.id
       JOIN test_results tr ON is2.test_result_id = tr.id
       JOIN test_runs trun ON tr.test_run_id = trun.id
       JOIN agents a ON trun.agent_id = a.id
       WHERE di.id = $1 AND a.user_id = $2`,
      [inferenceId, effectiveUserId]
    );

    if (inference.rows.length === 0) {
      return res.status(404).json({ error: 'Inference not found' });
    }

    const service = getInferenceScannerService(pool);
    await service.acknowledgeInference(inferenceId, user.id);

    res.json({ success: true });
  } catch (error) {
    console.error('Error acknowledging inference', error);
    next(error);
  }
}
