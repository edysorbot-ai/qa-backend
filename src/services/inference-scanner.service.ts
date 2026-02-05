import { Pool } from 'pg';
import OpenAI from 'openai';

// Types
export interface ImplicitInference {
  sourceStatement: string;
  turnNumber: number;
  inferredAttribute: string;
  category: 'age' | 'health' | 'religion' | 'disability' | 'sexuality' | 'financial' | 'political' | 'ethnicity' | 'other';
  confidence: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  regulations: string[];
  recommendation: string;
}

export interface InferenceScanResult {
  id: string;
  testResultId: string;
  scanStatus: 'pending' | 'scanning' | 'completed' | 'failed';
  overallRiskScore: number;
  complianceFlags: string[];
  actionRequired: boolean;
  inferences: ImplicitInference[];
  scannedAt: Date;
  errorMessage?: string;
}

// Category to regulation mapping
const CATEGORY_REGULATIONS: Record<string, string[]> = {
  age: ['COPPA', 'GDPR Article 8', 'CCPA'],
  health: ['HIPAA', 'GDPR Article 9', 'HITECH'],
  religion: ['Title VII', 'GDPR Article 9', 'ECHR Article 9'],
  disability: ['ADA', 'GDPR Article 9', 'Rehabilitation Act'],
  sexuality: ['Title VII', 'GDPR Article 9', 'EEOC Guidelines'],
  financial: ['FCRA', 'GLBA', 'ECOA'],
  political: ['GDPR Article 9', 'Hatch Act', 'First Amendment'],
  ethnicity: ['Title VII', 'GDPR Article 9', 'Civil Rights Act'],
  other: ['GDPR', 'CCPA'],
};

// Risk level recommendations
const RISK_RECOMMENDATIONS: Record<string, string> = {
  critical: 'Immediate review required. Do not store or process this conversation. Consider deleting from logs.',
  high: 'Review recommended. Ensure proper consent mechanisms are in place. Limit data retention.',
  medium: 'Monitor this pattern. Consider adding explicit consent prompts to conversation flow.',
  low: 'Document for compliance audit. Standard data handling procedures apply.',
};

class InferenceScannerService {
  private pool: Pool;
  private openai: OpenAI;

  constructor(pool: Pool) {
    this.pool = pool;
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  /**
   * Scan a test result for implicit inferences
   */
  async scanTestResult(testResultId: string): Promise<InferenceScanResult> {
    // Create scan record
    const scanResult = await this.pool.query(
      `INSERT INTO inference_scans (test_result_id, scan_status)
       VALUES ($1, 'scanning')
       RETURNING id`,
      [testResultId]
    );
    const scanId = scanResult.rows[0].id;

    try {
      // Get conversation turns from test result
      const testResult = await this.pool.query(
        `SELECT conversation_turns, agent_transcript, test_caller_transcript
         FROM test_results WHERE id = $1`,
        [testResultId]
      );

      if (testResult.rows.length === 0) {
        throw new Error('Test result not found');
      }

      const { conversation_turns } = testResult.rows[0];
      
      if (!conversation_turns || conversation_turns.length === 0) {
        // No conversation to scan
        await this.pool.query(
          `UPDATE inference_scans 
           SET scan_status = 'completed', overall_risk_score = 0, scanned_at = NOW()
           WHERE id = $1`,
          [scanId]
        );
        return this.getScanResult(scanId);
      }

      // Build conversation text
      const conversationText = conversation_turns.map((turn: any, index: number) => 
        `Turn ${index + 1} (${turn.role}): ${turn.content}`
      ).join('\n');

      // Scan for inferences using OpenAI
      const inferences = await this.detectInferences(conversationText, conversation_turns);

      // Calculate overall risk score
      const { overallRiskScore, complianceFlags, actionRequired } = this.calculateRiskMetrics(inferences);

      // Store inferences
      for (const inference of inferences) {
        await this.pool.query(
          `INSERT INTO detected_inferences 
           (scan_id, source_statement, turn_number, inferred_attribute, category, 
            confidence, risk_level, regulations, recommendation)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            scanId,
            inference.sourceStatement,
            inference.turnNumber,
            inference.inferredAttribute,
            inference.category,
            inference.confidence,
            inference.riskLevel,
            JSON.stringify(inference.regulations),
            inference.recommendation,
          ]
        );
      }

      // Update scan with results
      await this.pool.query(
        `UPDATE inference_scans 
         SET scan_status = 'completed', 
             overall_risk_score = $1,
             compliance_flags = $2,
             action_required = $3,
             scanned_at = NOW()
         WHERE id = $4`,
        [overallRiskScore, JSON.stringify(complianceFlags), actionRequired, scanId]
      );

      return this.getScanResult(scanId);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[InferenceScanner] Scan failed', { scanId, error: errorMessage });

      await this.pool.query(
        `UPDATE inference_scans 
         SET scan_status = 'failed', error_message = $1, scanned_at = NOW()
         WHERE id = $2`,
        [errorMessage, scanId]
      );

      throw error;
    }
  }

  /**
   * Use OpenAI to detect implicit inferences
   */
  private async detectInferences(conversationText: string, turns: any[]): Promise<ImplicitInference[]> {
    const prompt = `Analyze this conversation for IMPLICIT inferences about the user. Look for statements that INDIRECTLY reveal sensitive information that was never explicitly stated.

Categories to detect:
- age: Any indication of being a minor, elderly, or specific age range
- health: Medical conditions, disabilities, mental health, medications
- religion: Religious beliefs, practices, or affiliations
- disability: Physical or mental disabilities, accessibility needs
- sexuality: Sexual orientation, gender identity, relationship status
- financial: Income level, employment status, financial difficulties
- political: Political views, party affiliations, voting preferences
- ethnicity: Race, national origin, cultural background

IMPORTANT: Only flag IMPLICIT inferences - information that was inferred from context, NOT explicitly stated.

Conversation:
${conversationText}

Respond with a JSON object containing an "inferences" array. Each inference should have:
- sourceStatement: The exact statement that led to the inference
- turnNumber: Which turn number (1-indexed)
- inferredAttribute: What was inferred (e.g., "User is likely a minor")
- category: One of: age, health, religion, disability, sexuality, financial, political, ethnicity, other
- confidence: 0.0 to 1.0 how confident the inference is
- riskLevel: low, medium, high, or critical based on sensitivity

If no implicit inferences are found, return {"inferences": []}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });

      const content = response.choices[0]?.message?.content || '{"inferences": []}';
      const parsed = JSON.parse(content);
      
      // Enrich with regulations and recommendations
      return (parsed.inferences || []).map((inf: any) => ({
        sourceStatement: inf.sourceStatement || '',
        turnNumber: inf.turnNumber || 0,
        inferredAttribute: inf.inferredAttribute || '',
        category: inf.category || 'other',
        confidence: Math.min(1, Math.max(0, inf.confidence || 0.5)),
        riskLevel: inf.riskLevel || 'medium',
        regulations: CATEGORY_REGULATIONS[inf.category] || CATEGORY_REGULATIONS.other,
        recommendation: RISK_RECOMMENDATIONS[inf.riskLevel] || RISK_RECOMMENDATIONS.medium,
      }));

    } catch (error) {
      console.error('[InferenceScanner] OpenAI detection failed', error);
      return [];
    }
  }

  /**
   * Calculate overall risk metrics from inferences
   */
  private calculateRiskMetrics(inferences: ImplicitInference[]): {
    overallRiskScore: number;
    complianceFlags: string[];
    actionRequired: boolean;
  } {
    if (inferences.length === 0) {
      return { overallRiskScore: 0, complianceFlags: [], actionRequired: false };
    }

    // Risk level weights
    const riskWeights = { critical: 100, high: 75, medium: 50, low: 25 };
    
    // Calculate weighted average
    const totalWeight = inferences.reduce((sum, inf) => 
      sum + (riskWeights[inf.riskLevel] * inf.confidence), 0);
    const overallRiskScore = Math.min(100, totalWeight / inferences.length);

    // Collect unique compliance flags
    const complianceFlags = [...new Set(
      inferences.flatMap(inf => inf.regulations)
    )];

    // Action required if any critical/high risk
    const actionRequired = inferences.some(
      inf => inf.riskLevel === 'critical' || inf.riskLevel === 'high'
    );

    return { overallRiskScore, complianceFlags, actionRequired };
  }

  /**
   * Get scan result by ID
   */
  async getScanResult(scanId: string): Promise<InferenceScanResult> {
    const scanResult = await this.pool.query(
      `SELECT * FROM inference_scans WHERE id = $1`,
      [scanId]
    );

    if (scanResult.rows.length === 0) {
      throw new Error('Scan not found');
    }

    const scan = scanResult.rows[0];

    const inferencesResult = await this.pool.query(
      `SELECT * FROM detected_inferences WHERE scan_id = $1 ORDER BY turn_number`,
      [scanId]
    );

    return {
      id: scan.id,
      testResultId: scan.test_result_id,
      scanStatus: scan.scan_status,
      overallRiskScore: parseFloat(scan.overall_risk_score) || 0,
      complianceFlags: scan.compliance_flags || [],
      actionRequired: scan.action_required,
      inferences: inferencesResult.rows.map(row => ({
        sourceStatement: row.source_statement,
        turnNumber: row.turn_number,
        inferredAttribute: row.inferred_attribute,
        category: row.category,
        confidence: parseFloat(row.confidence) || 0,
        riskLevel: row.risk_level,
        regulations: row.regulations || [],
        recommendation: row.recommendation,
      })),
      scannedAt: scan.scanned_at,
      errorMessage: scan.error_message,
    };
  }

  /**
   * Get scan for a test result (if exists)
   */
  async getScanForTestResult(testResultId: string): Promise<InferenceScanResult | null> {
    const result = await this.pool.query(
      `SELECT id FROM inference_scans WHERE test_result_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [testResultId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.getScanResult(result.rows[0].id);
  }

  /**
   * Get all scans for an agent's test results
   */
  async getScansForAgent(agentId: string): Promise<InferenceScanResult[]> {
    const scansResult = await this.pool.query(
      `SELECT is2.id 
       FROM inference_scans is2
       JOIN test_results tr ON is2.test_result_id = tr.id
       JOIN test_runs trun ON tr.test_run_id = trun.id
       WHERE trun.agent_id = $1
       ORDER BY is2.scanned_at DESC
       LIMIT 100`,
      [agentId]
    );

    const scans = await Promise.all(
      scansResult.rows.map(row => this.getScanResult(row.id))
    );

    return scans;
  }

  /**
   * Acknowledge an inference (mark as reviewed)
   */
  async acknowledgeInference(inferenceId: string, userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE detected_inferences 
       SET acknowledged = TRUE, acknowledged_by = $1, acknowledged_at = NOW()
       WHERE id = $2`,
      [userId, inferenceId]
    );
  }

  /**
   * Get compliance summary for an agent
   */
  async getComplianceSummary(agentId: string): Promise<{
    totalScans: number;
    totalInferences: number;
    byCategory: Record<string, number>;
    byRiskLevel: Record<string, number>;
    actionRequired: number;
    recentScans: InferenceScanResult[];
  }> {
    // Get counts
    const statsResult = await this.pool.query(
      `SELECT 
         COUNT(DISTINCT is2.id) as total_scans,
         COUNT(di.id) as total_inferences,
         SUM(CASE WHEN is2.action_required THEN 1 ELSE 0 END) as action_required
       FROM inference_scans is2
       LEFT JOIN detected_inferences di ON is2.id = di.scan_id
       JOIN test_results tr ON is2.test_result_id = tr.id
       JOIN test_runs trun ON tr.test_run_id = trun.id
       WHERE trun.agent_id = $1`,
      [agentId]
    );

    // Get category breakdown
    const categoryResult = await this.pool.query(
      `SELECT di.category, COUNT(*) as count
       FROM detected_inferences di
       JOIN inference_scans is2 ON di.scan_id = is2.id
       JOIN test_results tr ON is2.test_result_id = tr.id
       JOIN test_runs trun ON tr.test_run_id = trun.id
       WHERE trun.agent_id = $1
       GROUP BY di.category`,
      [agentId]
    );

    // Get risk level breakdown
    const riskResult = await this.pool.query(
      `SELECT di.risk_level, COUNT(*) as count
       FROM detected_inferences di
       JOIN inference_scans is2 ON di.scan_id = is2.id
       JOIN test_results tr ON is2.test_result_id = tr.id
       JOIN test_runs trun ON tr.test_run_id = trun.id
       WHERE trun.agent_id = $1
       GROUP BY di.risk_level`,
      [agentId]
    );

    const recentScans = await this.getScansForAgent(agentId);

    return {
      totalScans: parseInt(statsResult.rows[0]?.total_scans) || 0,
      totalInferences: parseInt(statsResult.rows[0]?.total_inferences) || 0,
      byCategory: Object.fromEntries(
        categoryResult.rows.map(r => [r.category, parseInt(r.count)])
      ),
      byRiskLevel: Object.fromEntries(
        riskResult.rows.map(r => [r.risk_level, parseInt(r.count)])
      ),
      actionRequired: parseInt(statsResult.rows[0]?.action_required) || 0,
      recentScans: recentScans.slice(0, 10),
    };
  }
}

// Singleton instance
let inferenceScannerService: InferenceScannerService | null = null;

export function getInferenceScannerService(pool: Pool): InferenceScannerService {
  if (!inferenceScannerService) {
    inferenceScannerService = new InferenceScannerService(pool);
  }
  return inferenceScannerService;
}

export { InferenceScannerService };
