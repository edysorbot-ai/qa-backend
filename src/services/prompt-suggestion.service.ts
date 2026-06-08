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

  /**
   * Item 30: when the underlying LLM changes (e.g. customer migrates an agent
   * from gpt-4o to claude-3-5-sonnet or vice versa), suggest prompt
   * readjustments. Compares the prompt's STYLE expectations against the new
   * model's known quirks.
   *
   * Returns a list of bullet-style recommendations that the user can
   * accept/reject before pushing to the provider.
   */
  async suggestPromptReadjustmentForLLMChange(params: {
    currentPrompt: string;
    fromModel: string;
    toModel: string;
    agentName?: string;
    agentDomain?: string;
  }): Promise<Array<{ section: string; issue: string; suggestion: string; severity: 'low' | 'medium' | 'high' }>> {
    try {
      const sys = `You are a prompt-engineering expert who specialises in cross-model prompt portability. You will be given a system prompt currently optimised for one LLM, and the target LLM the user wants to switch to. Identify concrete adjustments needed.

KNOWN MODEL QUIRKS:
- gpt-4o / gpt-4o-mini: follow numbered steps well; tolerate long preambles; respect "DO NOT" instructions reliably; sometimes verbose unless told otherwise.
- gpt-3.5-turbo: needs SHORTER prompts; struggles with long enumerations; needs explicit examples rather than abstract rules.
- claude-3-5-sonnet / claude-3-opus: prefer XML tags for structure; respond better to <instructions> blocks than markdown headings; tend to add caveats unless told not to.
- claude-3-haiku: similar to sonnet but shorter context; needs the most critical rules at the TOP.
- gemini-1.5-pro / gemini-2.0-flash: strict about JSON output; struggles with implicit role-play; needs explicit examples for tool calls.
- llama-3 family: needs FEWER constraints — too many rules cause refusal loops. Avoid double negatives.
- mistral-large: similar to llama but tolerates more rules; struggles with ambiguous pronouns.

For each adjustment, return: {section, issue, suggestion, severity}. severity=high means the prompt will likely produce wrong behaviour on the new model without this fix.

Return JSON: {"adjustments": [...]}. Limit to the top 5 most important changes.`;

      const usr = `CURRENT PROMPT (optimised for ${params.fromModel}):
${params.currentPrompt}

SWITCHING TO: ${params.toModel}
${params.agentName ? `AGENT: ${params.agentName}` : ''}
${params.agentDomain ? `DOMAIN: ${params.agentDomain}` : ''}

List the concrete prompt adjustments needed to keep the same behaviour on ${params.toModel}.`;

      const response = await this.getOpenAI().chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: usr },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
        max_tokens: 1200,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return [];
      const parsed = JSON.parse(content);
      const arr = Array.isArray(parsed.adjustments) ? parsed.adjustments : [];
      return arr
        .filter((a: any) => a && a.suggestion)
        .slice(0, 5)
        .map((a: any) => ({
          section: typeof a.section === 'string' ? a.section : 'General',
          issue: typeof a.issue === 'string' ? a.issue : '',
          suggestion: typeof a.suggestion === 'string' ? a.suggestion : '',
          severity: ['low', 'medium', 'high'].includes(a.severity) ? a.severity : 'medium',
        }));
    } catch (err) {
      console.error('[PromptSuggestionService] suggestPromptReadjustmentForLLMChange error', err);
      return [];
    }
  }
}

export const promptSuggestionService = new PromptSuggestionService();
