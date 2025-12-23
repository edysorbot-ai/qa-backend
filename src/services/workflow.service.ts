/**
 * Workflow Service
 * Handles CRUD operations for test workflows
 */

import { query } from '../db';
import { 
  TestWorkflow, 
  CreateWorkflowDTO, 
  UpdateWorkflowDTO,
  WorkflowExecutionPlan,
  ExecutionGroup,
  CallNodeData,
} from '../models/workflow.model';
import { v4 as uuidv4 } from 'uuid';

class WorkflowService {
  /**
   * Create a new workflow for an agent
   */
  async create(data: CreateWorkflowDTO): Promise<TestWorkflow> {
    const id = uuidv4();

    const result = await query(
      `INSERT INTO test_workflows (id, agent_id, user_id, name, description, nodes, edges, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        data.agent_id,
        data.user_id,
        data.name,
        data.description || null,
        JSON.stringify(data.nodes),
        JSON.stringify(data.edges),
        true,
      ]
    );

    return this.mapRowToWorkflow(result.rows[0]);
  }

  /**
   * Get workflow by ID
   */
  async getById(id: string): Promise<TestWorkflow | null> {
    const result = await query(
      'SELECT * FROM test_workflows WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return null;
    return this.mapRowToWorkflow(result.rows[0]);
  }

  /**
   * Get workflow by agent ID (returns the active workflow for the agent)
   */
  async getByAgentId(agentId: string): Promise<TestWorkflow | null> {
    const result = await query(
      'SELECT * FROM test_workflows WHERE agent_id = $1 AND is_active = true ORDER BY updated_at DESC LIMIT 1',
      [agentId]
    );
    if (result.rows.length === 0) return null;
    return this.mapRowToWorkflow(result.rows[0]);
  }

  /**
   * Get all workflows for an agent
   */
  async getByAgentIdAll(agentId: string): Promise<TestWorkflow[]> {
    const result = await query(
      'SELECT * FROM test_workflows WHERE agent_id = $1 ORDER BY updated_at DESC',
      [agentId]
    );
    return result.rows.map((row: any) => this.mapRowToWorkflow(row));
  }

  /**
   * Update a workflow
   */
  async update(id: string, data: UpdateWorkflowDTO): Promise<TestWorkflow | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.name !== undefined) {
      fields.push(`name = $${paramCount++}`);
      values.push(data.name);
    }
    if (data.description !== undefined) {
      fields.push(`description = $${paramCount++}`);
      values.push(data.description);
    }
    if (data.nodes !== undefined) {
      fields.push(`nodes = $${paramCount++}`);
      values.push(JSON.stringify(data.nodes));
    }
    if (data.edges !== undefined) {
      fields.push(`edges = $${paramCount++}`);
      values.push(JSON.stringify(data.edges));
    }
    if (data.is_active !== undefined) {
      fields.push(`is_active = $${paramCount++}`);
      values.push(data.is_active);
    }

    if (fields.length === 0) return existing;

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await query(
      `UPDATE test_workflows SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    return this.mapRowToWorkflow(result.rows[0]);
  }

  /**
   * Upsert a workflow for an agent (create or update)
   */
  async upsert(data: CreateWorkflowDTO): Promise<TestWorkflow> {
    const existing = await this.getByAgentId(data.agent_id);
    
    if (existing) {
      const updated = await this.update(existing.id, {
        name: data.name,
        description: data.description,
        nodes: data.nodes,
        edges: data.edges,
      });
      return updated!;
    }
    
    return this.create(data);
  }

  /**
   * Delete a workflow
   */
  async delete(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM test_workflows WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Generate execution plan from workflow
   */
  generateExecutionPlan(workflow: TestWorkflow): WorkflowExecutionPlan {
    const { nodes, edges } = workflow;
    
    // Get all call nodes
    const callNodes = nodes.filter(n => n.type === 'callNode');
    
    if (callNodes.length === 0) {
      return { executionGroups: [], totalCalls: 0, totalTestCases: 0 };
    }

    // Build adjacency list from edges
    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();
    
    edges.forEach(edge => {
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      outgoing.get(edge.source)!.push(edge.target);
      
      if (!incoming.has(edge.target)) incoming.set(edge.target, []);
      incoming.get(edge.target)!.push(edge.source);
    });

    // Find start connections
    const startConnections = outgoing.get('start') || [];
    
    // Group nodes by execution order using BFS
    const executionGroups: ExecutionGroup[] = [];
    const visited = new Set<string>();
    let currentLevel = startConnections.filter(id =>
      callNodes.some(n => n.id === id)
    );

    let order = 0;
    while (currentLevel.length > 0) {
      const group: ExecutionGroup = {
        order,
        calls: [],
        concurrent: currentLevel.length > 1,
      };

      currentLevel.forEach(nodeId => {
        if (visited.has(nodeId)) return;
        visited.add(nodeId);

        const node = callNodes.find(n => n.id === nodeId);
        if (node) {
          const data = node.data as CallNodeData;
          group.calls.push({
            callNodeId: node.id,
            callLabel: data.label,
            testCases: data.testCases || [],
            concurrency: data.concurrency || 1,
          });
        }
      });

      if (group.calls.length > 0) {
        executionGroups.push(group);
      }

      // Get next level
      const nextLevel: string[] = [];
      currentLevel.forEach(nodeId => {
        const children = outgoing.get(nodeId) || [];
        children.forEach(childId => {
          if (!visited.has(childId) && callNodes.some(n => n.id === childId)) {
            nextLevel.push(childId);
          }
        });
      });

      currentLevel = nextLevel;
      order++;
    }

    const totalTestCases = executionGroups.reduce(
      (sum, group) =>
        sum + group.calls.reduce((s, call) => s + call.testCases.length, 0),
      0
    );

    return {
      executionGroups,
      totalCalls: callNodes.length,
      totalTestCases,
    };
  }

  /**
   * Sync test cases from workflow to database
   * Creates new test cases and updates modified ones
   */
  async syncTestCases(
    workflow: TestWorkflow, 
    userId: string
  ): Promise<{ created: number; updated: number }> {
    const { nodes } = workflow;
    const callNodes = nodes.filter(n => n.type === 'callNode');
    
    let created = 0;
    let updated = 0;

    for (const node of callNodes) {
      const data = node.data as CallNodeData;
      
      for (const tc of data.testCases || []) {
        // Check if this is a temporary (new) test case
        if (tc.id.startsWith('temp_tc_')) {
          // Create new test case in database
          const newId = uuidv4();
          await query(
            `INSERT INTO test_cases (id, agent_id, user_id, name, scenario, category, expected_behavior, priority)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              newId,
              workflow.agent_id,
              userId,
              tc.name,
              tc.scenario,
              tc.category,
              tc.expectedOutcome,
              tc.priority,
            ]
          );
          
          // Update the workflow node with the new ID
          tc.id = newId;
          created++;
        } else {
          // Update existing test case
          await query(
            `UPDATE test_cases 
             SET name = $1, scenario = $2, category = $3, expected_behavior = $4, priority = $5, updated_at = CURRENT_TIMESTAMP
             WHERE id = $6`,
            [tc.name, tc.scenario, tc.category, tc.expectedOutcome, tc.priority, tc.id]
          );
          updated++;
        }
      }
    }

    // Save the updated workflow with new IDs
    if (created > 0) {
      await this.update(workflow.id, { nodes: workflow.nodes });
    }

    return { created, updated };
  }

  private mapRowToWorkflow(row: any): TestWorkflow {
    return {
      id: row.id,
      agent_id: row.agent_id,
      user_id: row.user_id,
      name: row.name,
      description: row.description,
      nodes: typeof row.nodes === 'string' ? JSON.parse(row.nodes) : row.nodes,
      edges: typeof row.edges === 'string' ? JSON.parse(row.edges) : row.edges,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

export const workflowService = new WorkflowService();
