import { Request, Response } from 'express';
import { query } from '../db';

interface ObservabilityMetrics {
  totalCalls: number;
  totalCallsChange: number;
  avgScore: number;
  avgScoreChange: number;
  successRate: number;
  successRateChange: number;
  avgDuration: number;
  avgDurationChange: number;
  issuesFound: number;
  issuesChange: number;
  alertsTriggered: number;
}

interface TrendDataPoint {
  date: string;
  score: number;
  calls: number;
  successRate: number;
  avgDuration: number;
}

export class ObservabilityController {
  /**
   * Get overview metrics for observability dashboard
   */
  async getMetrics(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { agentId, timeRange } = req.query;
      
      // Calculate time intervals based on timeRange
      let intervalDays = 7;
      switch (timeRange) {
        case '24h': intervalDays = 1; break;
        case '7d': intervalDays = 7; break;
        case '30d': intervalDays = 30; break;
        case '90d': intervalDays = 90; break;
      }

      const currentPeriodStart = new Date();
      currentPeriodStart.setDate(currentPeriodStart.getDate() - intervalDays);
      
      const previousPeriodStart = new Date(currentPeriodStart);
      previousPeriodStart.setDate(previousPeriodStart.getDate() - intervalDays);

      // Build agent filter
      const agentFilter = agentId && agentId !== 'all' 
        ? 'AND tr.agent_id = $2' 
        : '';
      const params = agentId && agentId !== 'all' 
        ? [userId, agentId, currentPeriodStart, previousPeriodStart]
        : [userId, currentPeriodStart, previousPeriodStart];

      // Get current period metrics from test_results
      const currentMetricsQuery = `
        SELECT 
          COUNT(*) as total_calls,
          AVG(CASE WHEN tres.metrics->>'overallScore' IS NOT NULL 
              THEN (tres.metrics->>'overallScore')::numeric ELSE 0 END) as avg_score,
          COUNT(CASE WHEN tres.status = 'passed' THEN 1 END)::float / 
            NULLIF(COUNT(*)::float, 0) * 100 as success_rate,
          AVG(tres.duration_ms / 1000.0) as avg_duration,
          COUNT(CASE WHEN tres.status = 'failed' THEN 1 END) as issues_found
        FROM test_results tres
        JOIN test_runs tr ON tres.test_run_id = tr.id
        WHERE tr.user_id = $1 
          ${agentFilter}
          AND tres.created_at >= $${agentId && agentId !== 'all' ? 3 : 2}
      `;

      const previousMetricsQuery = `
        SELECT 
          COUNT(*) as total_calls,
          AVG(CASE WHEN tres.metrics->>'overallScore' IS NOT NULL 
              THEN (tres.metrics->>'overallScore')::numeric ELSE 0 END) as avg_score,
          COUNT(CASE WHEN tres.status = 'passed' THEN 1 END)::float / 
            NULLIF(COUNT(*)::float, 0) * 100 as success_rate,
          AVG(tres.duration_ms / 1000.0) as avg_duration,
          COUNT(CASE WHEN tres.status = 'failed' THEN 1 END) as issues_found
        FROM test_results tres
        JOIN test_runs tr ON tres.test_run_id = tr.id
        WHERE tr.user_id = $1 
          ${agentFilter}
          AND tres.created_at >= $${agentId && agentId !== 'all' ? 4 : 3}
          AND tres.created_at < $${agentId && agentId !== 'all' ? 3 : 2}
      `;

      const [currentResult, previousResult] = await Promise.all([
        query(currentMetricsQuery, agentId && agentId !== 'all' 
          ? [userId, agentId, currentPeriodStart] 
          : [userId, currentPeriodStart]),
        query(previousMetricsQuery, agentId && agentId !== 'all'
          ? [userId, agentId, previousPeriodStart, currentPeriodStart]
          : [userId, previousPeriodStart, currentPeriodStart]),
      ]);

      const current = currentResult.rows[0] || {};
      const previous = previousResult.rows[0] || {};

      // Calculate percentage changes
      const calculateChange = (current: number, previous: number): number => {
        if (!previous || previous === 0) return current > 0 ? 100 : 0;
        return ((current - previous) / previous) * 100;
      };

      // Get alert count
      const alertsResult = await query(
        `SELECT COUNT(*) as count FROM alert_settings 
         WHERE user_id = $1 AND active = true`,
        [userId]
      );

      const metrics: ObservabilityMetrics = {
        totalCalls: parseInt(current.total_calls) || 0,
        totalCallsChange: calculateChange(
          parseInt(current.total_calls) || 0, 
          parseInt(previous.total_calls) || 0
        ),
        avgScore: Math.round(parseFloat(current.avg_score) || 0),
        avgScoreChange: calculateChange(
          parseFloat(current.avg_score) || 0,
          parseFloat(previous.avg_score) || 0
        ),
        successRate: Math.round(parseFloat(current.success_rate) || 0),
        successRateChange: calculateChange(
          parseFloat(current.success_rate) || 0,
          parseFloat(previous.success_rate) || 0
        ),
        avgDuration: Math.round(parseFloat(current.avg_duration) || 0),
        avgDurationChange: calculateChange(
          parseFloat(current.avg_duration) || 0,
          parseFloat(previous.avg_duration) || 0
        ),
        issuesFound: parseInt(current.issues_found) || 0,
        issuesChange: calculateChange(
          parseInt(current.issues_found) || 0,
          parseInt(previous.issues_found) || 0
        ),
        alertsTriggered: parseInt(alertsResult.rows[0]?.count) || 0,
      };

      res.json(metrics);
    } catch (error) {
      console.error('Error fetching observability metrics:', error);
      res.status(500).json({ error: 'Failed to fetch metrics' });
    }
  }

  /**
   * Get trend data for charts
   */
  async getTrends(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { agentId, timeRange } = req.query;

      let intervalDays = 7;
      switch (timeRange) {
        case '24h': intervalDays = 1; break;
        case '7d': intervalDays = 7; break;
        case '30d': intervalDays = 30; break;
        case '90d': intervalDays = 90; break;
      }

      const agentFilter = agentId && agentId !== 'all' 
        ? 'AND tr.agent_id = $2' 
        : '';

      const trendsQuery = `
        SELECT 
          DATE(tres.created_at) as date,
          AVG(CASE WHEN tres.metrics->>'overallScore' IS NOT NULL 
              THEN (tres.metrics->>'overallScore')::numeric ELSE 0 END) as score,
          COUNT(*) as calls,
          COUNT(CASE WHEN tres.status = 'passed' THEN 1 END)::float / 
            NULLIF(COUNT(*)::float, 0) * 100 as success_rate,
          AVG(tres.duration_ms / 1000.0) as avg_duration
        FROM test_results tres
        JOIN test_runs tr ON tres.test_run_id = tr.id
        WHERE tr.user_id = $1 
          ${agentFilter}
          AND tres.created_at >= NOW() - INTERVAL '${intervalDays} days'
        GROUP BY DATE(tres.created_at)
        ORDER BY date
      `;

      const result = await query(
        trendsQuery, 
        agentId && agentId !== 'all' ? [userId, agentId] : [userId]
      );

      const trends: TrendDataPoint[] = result.rows.map(row => ({
        date: row.date,
        score: Math.round(parseFloat(row.score) || 0),
        calls: parseInt(row.calls) || 0,
        successRate: Math.round(parseFloat(row.success_rate) || 0),
        avgDuration: Math.round(parseFloat(row.avg_duration) || 0),
      }));

      res.json({ trends });
    } catch (error) {
      console.error('Error fetching trends:', error);
      res.status(500).json({ error: 'Failed to fetch trends' });
    }
  }

  /**
   * Get alerts
   */
  async getAlerts(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { agentId, limit = 10 } = req.query;

      // For now, return alerts based on recent test failures
      const agentFilter = agentId && agentId !== 'all' 
        ? 'AND tr.agent_id = $2' 
        : '';

      const alertsQuery = `
        SELECT 
          tres.id,
          tres.status,
          tres.test_case_name,
          tres.metrics,
          tres.created_at,
          tr.agent_id,
          a.name as agent_name
        FROM test_results tres
        JOIN test_runs tr ON tres.test_run_id = tr.id
        JOIN agents a ON tr.agent_id = a.id
        WHERE tr.user_id = $1 
          ${agentFilter}
          AND tres.status = 'failed'
        ORDER BY tres.created_at DESC
        LIMIT $${agentId && agentId !== 'all' ? 3 : 2}
      `;

      const result = await query(
        alertsQuery,
        agentId && agentId !== 'all' 
          ? [userId, agentId, limit] 
          : [userId, limit]
      );

      const alerts = result.rows.map(row => ({
        id: row.id,
        type: 'error' as const,
        title: `Test Failed: ${row.test_case_name}`,
        description: `Score: ${row.metrics?.overallScore || 0}%`,
        agentName: row.agent_name,
        timestamp: row.created_at,
        acknowledged: false,
      }));

      res.json({ alerts });
    } catch (error) {
      console.error('Error fetching alerts:', error);
      res.status(500).json({ error: 'Failed to fetch alerts' });
    }
  }

  /**
   * Get performance by agent
   */
  async getAgentPerformance(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { timeRange } = req.query;

      let intervalDays = 7;
      switch (timeRange) {
        case '24h': intervalDays = 1; break;
        case '7d': intervalDays = 7; break;
        case '30d': intervalDays = 30; break;
        case '90d': intervalDays = 90; break;
      }

      const performanceQuery = `
        SELECT 
          a.id as agent_id,
          a.name as agent_name,
          COUNT(*) as total_calls,
          AVG(CASE WHEN tres.metrics->>'overallScore' IS NOT NULL 
              THEN (tres.metrics->>'overallScore')::numeric ELSE 0 END) as avg_score,
          COUNT(CASE WHEN tres.status = 'passed' THEN 1 END)::float / 
            NULLIF(COUNT(*)::float, 0) * 100 as success_rate
        FROM test_results tres
        JOIN test_runs tr ON tres.test_run_id = tr.id
        JOIN agents a ON tr.agent_id = a.id
        WHERE tr.user_id = $1 
          AND tres.created_at >= NOW() - INTERVAL '${intervalDays} days'
        GROUP BY a.id, a.name
        ORDER BY avg_score DESC
      `;

      const result = await query(performanceQuery, [userId]);

      const performance = result.rows.map(row => ({
        agentId: row.agent_id,
        agentName: row.agent_name,
        totalCalls: parseInt(row.total_calls) || 0,
        avgScore: Math.round(parseFloat(row.avg_score) || 0),
        successRate: Math.round(parseFloat(row.success_rate) || 0),
        trend: 'stable' as const, // Would need historical comparison
      }));

      res.json({ performance });
    } catch (error) {
      console.error('Error fetching agent performance:', error);
      res.status(500).json({ error: 'Failed to fetch agent performance' });
    }
  }

  /**
   * Get issue breakdown
   */
  async getIssueBreakdown(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { agentId, timeRange } = req.query;

      let intervalDays = 7;
      switch (timeRange) {
        case '24h': intervalDays = 1; break;
        case '7d': intervalDays = 7; break;
        case '30d': intervalDays = 30; break;
        case '90d': intervalDays = 90; break;
      }

      const agentFilter = agentId && agentId !== 'all' 
        ? 'AND tr.agent_id = $2' 
        : '';

      // Get failed test results and analyze issues
      const issuesQuery = `
        SELECT 
          tres.metrics,
          tres.analysis
        FROM test_results tres
        JOIN test_runs tr ON tres.test_run_id = tr.id
        WHERE tr.user_id = $1 
          ${agentFilter}
          AND tres.status = 'failed'
          AND tres.created_at >= NOW() - INTERVAL '${intervalDays} days'
      `;

      const result = await query(
        issuesQuery,
        agentId && agentId !== 'all' ? [userId, agentId] : [userId]
      );

      // Categorize issues
      const issueCounts: Record<string, number> = {
        'Hallucination': 0,
        'Script Deviation': 0,
        'Slow Response': 0,
        'Audio Quality': 0,
        'Incomplete Response': 0,
        'Wrong Information': 0,
      };

      result.rows.forEach(row => {
        const analysis = row.analysis || {};
        const issues = analysis.issues || [];
        
        issues.forEach((issue: any) => {
          const issueType = issue.type || 'Other';
          if (issueType.toLowerCase().includes('hallucin')) {
            issueCounts['Hallucination']++;
          } else if (issueType.toLowerCase().includes('script') || issueType.toLowerCase().includes('deviation')) {
            issueCounts['Script Deviation']++;
          } else if (issueType.toLowerCase().includes('slow') || issueType.toLowerCase().includes('latency')) {
            issueCounts['Slow Response']++;
          } else if (issueType.toLowerCase().includes('audio') || issueType.toLowerCase().includes('quality')) {
            issueCounts['Audio Quality']++;
          } else if (issueType.toLowerCase().includes('incomplete')) {
            issueCounts['Incomplete Response']++;
          } else if (issueType.toLowerCase().includes('wrong') || issueType.toLowerCase().includes('incorrect')) {
            issueCounts['Wrong Information']++;
          }
        });
      });

      const totalIssues = Object.values(issueCounts).reduce((a, b) => a + b, 0) || 1;

      const breakdown = Object.entries(issueCounts)
        .filter(([_, count]) => count > 0)
        .map(([type, count]) => ({
          type,
          count,
          percentage: Math.round((count / totalIssues) * 100),
          severity: type === 'Hallucination' || type === 'Wrong Information' 
            ? 'critical' 
            : type === 'Script Deviation' 
              ? 'high' 
              : type === 'Slow Response' 
                ? 'medium' 
                : 'low',
        }))
        .sort((a, b) => b.count - a.count);

      res.json({ breakdown });
    } catch (error) {
      console.error('Error fetching issue breakdown:', error);
      res.status(500).json({ error: 'Failed to fetch issue breakdown' });
    }
  }
}

export const observabilityController = new ObservabilityController();
