import OpenAI from 'openai';
import { PromptSuggestion } from '../models/testResult.model';

export class PromptSuggestionService {
  private openai: OpenAI | null = null;

  private getOpenAI(): OpenAI {
    if (!this.openai) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
    return this.openai;
  }

  /**
   * Generate AI-powered prompt improvement suggestions based on test failure
   */
  async generatePromptSuggestions(params: {
    testCaseName: string;
    category: string;
    scenario: string;
    userInput: string;
    expectedResponse: string;
    actualResponse: string;
    agentTranscript?: string;
  }): Promise<PromptSuggestion[]> {
    try {
      const prompt = `You are an AI agent prompt engineering expert. Analyze this failed test case and provide specific, actionable prompt improvements.

TEST CASE DETAILS:
Name: ${params.testCaseName}
Category: ${params.category}
Scenario: ${params.scenario}
User Input: ${params.userInput}

EXPECTED BEHAVIOR:
${params.expectedResponse}

ACTUAL AGENT RESPONSE:
${params.actualResponse}

${params.agentTranscript ? `FULL CONVERSATION:\n${params.agentTranscript}` : ''}

TASK:
Analyze why the agent failed to meet expectations. Provide exactly 1 specific, actionable prompt improvement that would fix this issue. Focus on the most impactful change.

For the suggestion, provide:
1. "issue": What specific problem caused the failure (be precise)
2. "suggestion": The EXACT text to add to the system prompt (make it copy-pastable)
3. "location": Which section of the prompt to add it (e.g., "System Instructions → Conversation Guidelines")
4. "priority": "high", "medium", or "low"

Respond in JSON format as an array with exactly 1 suggestion:
[
  {
    "issue": "Agent provided personal advice instead of redirecting to core purpose",
    "suggestion": "When users ask off-topic personal questions, immediately redirect: 'That's an interesting question, but I'm specifically designed to help with [purpose]. Let me get you back on track with [relevant topic].'",
    "location": "System Instructions → Boundaries & Redirects",
    "priority": "high"
  }
]

Be specific to THIS failure. Don't give generic advice.`;

      const response = await this.getOpenAI().chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return this.getFallbackSuggestions(params.category);
      }

      // Parse the response
      const parsed = JSON.parse(content);
      const suggestions = Array.isArray(parsed) ? parsed : parsed.suggestions || [];

      // Validate and return
      return suggestions.filter((s: any) => 
        s.issue && s.suggestion && s.location && s.priority
      ).slice(0, 1); // Only 1 suggestion per error

    } catch (error) {
      console.error('[PromptSuggestionService] Error generating suggestions:', error);
      return this.getFallbackSuggestions(params.category);
    }
  }

  /**
   * Fallback suggestions when AI fails
   */
  private getFallbackSuggestions(category: string): PromptSuggestion[] {
    const fallbacks: Record<string, PromptSuggestion[]> = {
      'Off-topic Handling': [
        {
          issue: 'Agent engaged with off-topic question instead of redirecting',
          suggestion: 'When users ask off-topic questions, politely redirect: "I appreciate your question, but I\'m designed to help with [your purpose]. Let\'s get you back on track with [relevant topic]."',
          location: 'System Instructions → Conversation Guidelines',
          priority: 'high',
        },
      ],
      'Budget Inquiry': [
        {
          issue: 'Agent didn\'t maintain exact currency format',
          suggestion: 'Always use exact currency symbols and amounts. If budget is "$5000", maintain the dollar sign and specific number. Don\'t round or generalize unless explicitly asked.',
          location: 'System Instructions → Data Accuracy',
          priority: 'high',
        },
      ],
      'User Requests Callback': [
        {
          issue: 'Agent didn\'t acknowledge callback request promptly',
          suggestion: 'When user requests callback, immediately acknowledge: "I understand you\'d like a callback. Let me collect your preferred contact details and time."',
          location: 'System Instructions → Call Handling',
          priority: 'high',
        },
      ],
    };

    return fallbacks[category] || [
      {
        issue: 'Agent response didn\'t match expected behavior',
        suggestion: `For ${category} scenarios: Ensure responses align with the expected outcome. Review and follow the specific guidelines for this category.`,
        location: `System Instructions → ${category}`,
        priority: 'medium',
      },
    ];
  }
}

export const promptSuggestionService = new PromptSuggestionService();
