/**
 * Test Workflow Model
 * Represents a visual test flow designed by the user
 */

export interface WorkflowNode {
  id: string;
  type: 'callNode' | 'testCaseNode' | 'startNode' | 'endNode';
  position: { x: number; y: number };
  data: Record<string, any>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  type?: string;
  animated?: boolean;
  label?: string;
}

export interface TestWorkflow {
  id: string;
  agent_id: string;
  user_id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateWorkflowDTO {
  agent_id: string;
  user_id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface UpdateWorkflowDTO {
  name?: string;
  description?: string;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  is_active?: boolean;
}

// Execution plan types for workflow-based test runs
export interface CallNodeData {
  id: string;
  label: string;
  testCases: TestCaseInWorkflow[];
  concurrency: number;
  order: number;
}

export interface TestCaseInWorkflow {
  id: string;
  name: string;
  scenario: string;
  category: string;
  expectedOutcome: string;
  priority: 'high' | 'medium' | 'low';
}

export interface WorkflowExecutionPlan {
  executionGroups: ExecutionGroup[];
  totalCalls: number;
  totalTestCases: number;
}

export interface ExecutionGroup {
  order: number;
  calls: CallExecution[];
  concurrent: boolean;
}

export interface CallExecution {
  callNodeId: string;
  callLabel: string;
  testCases: TestCaseInWorkflow[];
  concurrency: number;
}
