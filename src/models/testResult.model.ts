export type TestResultStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error';

export interface ConversationTurn {
  role: 'user' | 'agent';
  text: string;
  audio_url?: string;
  timestamp: number;
  latency_ms?: number;
}

// ============================================
// COMPREHENSIVE QUALITY METRICS (13 Categories)
// ============================================

// 1. Conversation Quality Metrics (Core Evaluator Layer)
export interface ConversationQualityMetrics {
  // Understanding and Intent Handling
  intentDetectionAccuracy?: number;
  intentConfidenceScore?: number;
  wrongIntentClassificationRate?: number;
  intentSwitchingFrequency?: number;
  missedIntentInstances?: number;
  ambiguousIntentResolutionScore?: number;
  multiIntentHandlingSuccessRate?: number;
  
  // Context Management
  contextRetentionScore?: number;
  contextLossIncidents?: number;
  longConversationCoherenceScore?: number;
  followUpRelevanceScore?: number;
  repetitionRateDueToContextFailure?: number;
  
  // Response Quality
  responseRelevanceScore?: number;
  hallucinationFrequency?: number;
  offScriptResponseRate?: number;
  overVerboseResponseRate?: number;
  underInformativeResponseRate?: number;
  fillerResponseRatio?: number;
  unsafeOrPolicyViolatingResponses?: number;
  
  // Linguistic Quality
  grammarAccuracy?: number;
  pronunciationClarity?: number;
  accentConsistency?: number;
  toneAlignmentScore?: number;
  empathyScore?: number;
  naturalnessScore?: number;
  speechDisfluencyRate?: number;
}

// 2. Prompt Compliance and Instruction Adherence
export interface PromptComplianceMetrics {
  // Prompt Adherence
  systemPromptComplianceScore?: number;
  instructionViolationCount?: number;
  missingMandatorySteps?: number;
  incorrectFlowExecution?: number;
  incorrectEscalationHandling?: number;
  promptDriftOverConversationLength?: number;
  
  // Rule Violations
  forbiddenPhraseUsage?: number;
  missingComplianceStatements?: number;
  wrongFallbackBehavior?: number;
  improperHandoverPhrasing?: number;
  invalidDataCollectionAttempts?: number;
}

// 3. Conversation Outcome Effectiveness
export interface ConversationOutcomeMetrics {
  // Goal Completion
  goalCompletionRate?: number;
  partialCompletionRate?: number;
  failedCompletionRate?: number;
  abandonedConversationRate?: number;
  userDisengagementPoints?: number;
  
  // Funnel Performance
  leadQualificationAccuracy?: number;
  dataCaptureCompleteness?: number;
  appointmentBookingSuccessRate?: number;
  escalationSuccessRate?: number;
  callbackSchedulingAccuracy?: number;
}

// 4. Voice-Specific Performance Metrics
export interface VoicePerformanceMetrics {
  // Audio Quality
  audioClarityScore?: number;
  backgroundNoiseInterference?: number;
  latencySpikes?: number;
  audioCutoffIncidents?: number;
  voiceOverlapIncidents?: number;
  
  // Speech Dynamics
  speechSpeedConsistency?: number;
  pauseAppropriatenessScore?: number;
  turnTakingAccuracy?: number;
  interruptionRate?: number;
  silenceThresholdViolations?: number;
  
  // TTS Performance
  voiceStabilityScore?: number;
  emotionModulationAccuracy?: number;
  pronunciationErrorRate?: number;
  mispronouncedEntityCount?: number;
  voiceResetIncidents?: number;
}

// 5. Latency and System Performance Metrics
export interface SystemPerformanceMetrics {
  // Response Timing
  firstResponseLatencyMs?: number;
  averageResponseLatencyMs?: number;
  p95LatencyMs?: number;
  p99LatencyMs?: number;
  timeoutFrequency?: number;
  retryOccurrences?: number;
  
  // Platform Stability
  apiFailureRate?: number;
  retrySuccessRate?: number;
  sessionCrashRate?: number;
  providerSpecificFailureRates?: Record<string, number>;
}

// 6. User Experience Metrics
export interface UserExperienceMetrics {
  // Engagement
  userSpeakingTimeRatio?: number;
  agentSpeakingTimeRatio?: number;
  userInterruptionFrequency?: number;
  frustrationIndicators?: number;
  sentimentTrendOverTime?: number[];
  dropOffSentimentScore?: number;
  
  // Satisfaction Proxies
  conversationalSmoothnessScore?: number;
  repetitionAnnoyanceScore?: number;
  clarificationRequestsCount?: number;
  userCorrectionFrequency?: number;
}

// 7. Error Detection and Root Cause Metrics
export interface ErrorDetectionMetrics {
  // Error Categorization
  asrErrors?: number;
  nluErrors?: number;
  promptLogicErrors?: number;
  toolInvocationErrors?: number;
  integrationErrors?: number;
  
  // Root Cause Attribution
  modelLimitationErrors?: number;
  promptDesignFlawErrors?: number;
  providerLatencyErrors?: number;
  toolApiFailureErrors?: number;
  userBehaviorAnomalyErrors?: number;
  
  // Error Details
  errorCategories?: Array<{
    type: string;
    count: number;
    severity: 'critical' | 'warning' | 'info';
    rootCause: string;
  }>;
}

// 8. Comparative and Benchmarking Metrics
export interface BenchmarkingMetrics {
  // Model Comparison
  modelWiseAccuracy?: Record<string, number>;
  providerWiseLatency?: Record<string, number>;
  costPerSuccessfulConversation?: number;
  errorRatePerProvider?: Record<string, number>;
  completionRatePerProvider?: Record<string, number>;
  
  // Versioning
  beforeAfterPromptChangeImpact?: number;
  modelUpgradeImpactAnalysis?: number;
  regressionDetectionScore?: number;
}

// 9. Cost and Efficiency Metrics
export interface CostEfficiencyMetrics {
  // Cost Efficiency
  costPerCompletedConversation?: number;
  costPerQualifiedLead?: number;
  costPerEscalation?: number;
  tokenToOutcomeRatio?: number;
  voiceMinuteWastePercentage?: number;
  
  // Optimization Indicators
  overTalkingCostLoss?: number;
  redundantTokenUsage?: number;
  silenceCostRatio?: number;
  
  // Token Usage
  totalTokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// 10. Compliance, Risk, and Safety Metrics
export interface ComplianceSafetyMetrics {
  sensitiveDataLeakageIncidents?: number;
  piiHandlingViolations?: number;
  consentHandlingAccuracy?: number;
  complianceScriptAdherence?: number;
  riskExposureScore?: number;
  
  // Detailed violations
  violations?: Array<{
    type: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    timestamp?: number;
  }>;
}

// 11. Evaluator Intelligence Metrics (Meta Layer)
export interface EvaluatorMetrics {
  evaluationConfidenceScore?: number;
  falsePositiveRate?: number;
  falseNegativeRate?: number;
  manualOverrideFrequency?: number;
  evaluatorAgreementScoreWithHumanQA?: number;
}

// 12. Actionable Insights and Recommendations
export interface ActionableInsights {
  autoPromptImprovementSuggestions?: Array<{
    issue: string;
    suggestion: string;
    location: string;
    priority: 'high' | 'medium' | 'low';
    expectedImpact: string;
  }>;
  conversationRewriteSuggestions?: Array<{
    turnIndex: number;
    originalResponse: string;
    suggestedResponse: string;
    reason: string;
  }>;
  voiceTuningRecommendations?: string[];
  flowRestructuringSuggestions?: string[];
  escalationLogicImprovements?: string[];
}

// Combined Comprehensive Metrics Interface
export interface ComprehensiveTestMetrics {
  // Category 1: Conversation Quality
  conversationQuality?: ConversationQualityMetrics;
  
  // Category 2: Prompt Compliance
  promptCompliance?: PromptComplianceMetrics;
  
  // Category 3: Outcome Effectiveness
  outcomeEffectiveness?: ConversationOutcomeMetrics;
  
  // Category 4: Voice Performance
  voicePerformance?: VoicePerformanceMetrics;
  
  // Category 5: System Performance
  systemPerformance?: SystemPerformanceMetrics;
  
  // Category 6: User Experience
  userExperience?: UserExperienceMetrics;
  
  // Category 7: Error Detection
  errorDetection?: ErrorDetectionMetrics;
  
  // Category 8: Benchmarking
  benchmarking?: BenchmarkingMetrics;
  
  // Category 9: Cost Efficiency
  costEfficiency?: CostEfficiencyMetrics;
  
  // Category 10: Compliance & Safety
  complianceSafety?: ComplianceSafetyMetrics;
  
  // Category 11: Evaluator Metrics
  evaluatorMetrics?: EvaluatorMetrics;
  
  // Category 12: Actionable Insights
  actionableInsights?: ActionableInsights;
  
  // Overall Scores (Dashboard Summary)
  overallScore?: number;
  categoryScores?: {
    conversationQuality: number;
    promptCompliance: number;
    outcomeEffectiveness: number;
    voicePerformance: number;
    systemPerformance: number;
    userExperience: number;
    complianceSafety: number;
  };
}

// Legacy metrics interface (for backward compatibility)
export interface TestResultMetrics {
  intent_accuracy?: number;
  script_adherence?: number;
  response_latency_ms?: number;
  audio_clarity?: number;
  silence_ratio?: number;
  overlap_detected?: boolean;
  hallucination_detected?: boolean;
  
  // New comprehensive metrics
  comprehensive?: ComprehensiveTestMetrics;
}

export interface PromptSuggestion {
  issue: string;
  suggestion: string;
  location: string;
  priority: 'high' | 'medium' | 'low';
}

export interface TestResult {
  id: string;
  test_run_id: string;
  test_case_id: string;
  status: TestResultStatus;
  user_audio_url?: string;
  agent_audio_url?: string;
  user_transcript?: string;
  agent_transcript?: string;
  detected_intent?: string;
  intent_match: boolean;
  output_match: boolean;
  latency_ms?: number;
  conversation_turns: ConversationTurn[];
  metrics: TestResultMetrics;
  prompt_suggestions?: PromptSuggestion[];
  error_message?: string;
  started_at?: Date;
  completed_at?: Date;
  created_at: Date;
}

export interface CreateTestResultDTO {
  test_run_id: string;
  test_case_id: string;
}

export interface UpdateTestResultDTO {
  status?: TestResultStatus;
  user_audio_url?: string;
  agent_audio_url?: string;
  user_transcript?: string;
  agent_transcript?: string;
  detected_intent?: string;
  intent_match?: boolean;
  output_match?: boolean;
  latency_ms?: number;
  conversation_turns?: ConversationTurn[];
  metrics?: TestResultMetrics;
  prompt_suggestions?: PromptSuggestion[];
  error_message?: string;
  started_at?: Date;
  completed_at?: Date;
}
