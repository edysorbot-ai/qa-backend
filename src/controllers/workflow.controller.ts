/**
 * Workflow Controller
 * Handles HTTP requests for workflow operations
 */

import { Request, Response } from 'express';
import { workflowService } from '../services/workflow.service';
import { userService } from '../services/user.service';

export class WorkflowController {
  /**
   * Get workflow for an agent
   */
  async getWorkflow(req: Request, res: Response) {
    try {
      const { agentId } = req.params;
      const workflow = await workflowService.getByAgentId(agentId);
      
      if (!workflow) {
        return res.json({ workflow: null });
      }
      
      res.json({ workflow });
    } catch (error) {
      console.error('Error getting workflow:', error);
      res.status(500).json({ error: 'Failed to get workflow' });
    }
  }

  /**
   * Save/Update workflow for an agent
   */
  async saveWorkflow(req: Request, res: Response) {
    try {
      const { agentId } = req.params;
      const clerkUser = (req as any).auth;
      
      if (!clerkUser?.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      const userId = user.id;

      const { name, description, nodes, edges } = req.body;

      if (!name || !nodes || !edges) {
        return res.status(400).json({ 
          error: 'Missing required fields: name, nodes, edges' 
        });
      }

      const workflow = await workflowService.upsert({
        agent_id: agentId,
        user_id: userId,
        name,
        description,
        nodes,
        edges,
      });

      // Sync test cases with the database
      const syncResult = await workflowService.syncTestCases(workflow, userId);

      res.json({ 
        workflow,
        sync: syncResult,
        message: 'Workflow saved successfully',
      });
    } catch (error) {
      console.error('Error saving workflow:', error);
      res.status(500).json({ error: 'Failed to save workflow' });
    }
  }

  /**
   * Delete workflow
   */
  async deleteWorkflow(req: Request, res: Response) {
    try {
      const { agentId, workflowId } = req.params;
      
      const workflow = await workflowService.getById(workflowId);
      if (!workflow || workflow.agent_id !== agentId) {
        return res.status(404).json({ error: 'Workflow not found' });
      }

      await workflowService.delete(workflowId);
      
      res.json({ message: 'Workflow deleted successfully' });
    } catch (error) {
      console.error('Error deleting workflow:', error);
      res.status(500).json({ error: 'Failed to delete workflow' });
    }
  }

  /**
   * Get execution plan for a workflow
   */
  async getExecutionPlan(req: Request, res: Response) {
    try {
      const { agentId } = req.params;
      
      const workflow = await workflowService.getByAgentId(agentId);
      if (!workflow) {
        return res.status(404).json({ error: 'No workflow found for this agent' });
      }

      const executionPlan = workflowService.generateExecutionPlan(workflow);
      
      res.json({ executionPlan });
    } catch (error) {
      console.error('Error getting execution plan:', error);
      res.status(500).json({ error: 'Failed to generate execution plan' });
    }
  }
}

export const workflowController = new WorkflowController();
