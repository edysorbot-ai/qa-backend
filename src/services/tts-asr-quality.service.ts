/**
 * Item 16: TTS quality evaluator (transcript + metadata based).
 *
 * We do not run audio fingerprinting in Phase 1 (it requires shipping a heavy
 * binary). Instead we evaluate TTS quality from observable signals available
 * in the transcript and audio metadata:
 *   - words-per-minute (very high WPM => robotic / fast TTS)
 *   - segment / pause distribution (no pauses for breath => unnatural)
 *   - punctuation density (TTS without proper SSML often drops punctuation)
 *   - over-pronunciation of acronyms (e.g. "A-P-I" vs "API") inferable from
 *     spaced single letters in the agent's spoken text.
 *
 * Item 8: ASR quality tests share the same scoring framework but apply to
 * what the test CALLER said and how the AGENT understood it.
 */

export interface TtsQualitySignal {
  wordsPerMinute: number;
  punctuationDensity: number; // commas+periods+? per 100 chars
  acronymOverPronunciationCount: number;
  pauseSegments: number;
  averageSegmentChars: number;
}

export interface TtsQualityReport {
  score: number; // 0-100
  rating: 'natural' | 'acceptable' | 'robotic' | 'unintelligible';
  signals: TtsQualitySignal;
  issues: string[];
}

const ACRONYM_OVER_PRONOUNCE_RE = /\b(?:[A-Z]\s){1,5}[A-Z]\b/g;

export function evaluateTtsQuality(input: {
  spokenText: string;
  // Optional metadata: total duration of the audio in ms (so we can compute WPM)
  audioDurationMs?: number;
}): TtsQualityReport {
  const text = input.spokenText || '';
  const charCount = text.length;
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  const punctuationCount = (text.match(/[,.?!;:]/g) || []).length;
  const acronymMatches = (text.match(ACRONYM_OVER_PRONOUNCE_RE) || []).length;
  // Sentence-ish boundaries as pause segments
  const segments = text.split(/[.!?]+\s+/).filter(s => s.trim().length > 0);
  const avgSegmentChars = segments.length === 0 ? 0 : Math.round(charCount / segments.length);

  const durationSec = (input.audioDurationMs || 0) / 1000;
  const wpm = durationSec > 0 ? Math.round((wordCount / durationSec) * 60) : 0;
  const punctDensity = charCount === 0 ? 0 : Math.round((punctuationCount * 100) / charCount);

  const signals: TtsQualitySignal = {
    wordsPerMinute: wpm,
    punctuationDensity: punctDensity,
    acronymOverPronunciationCount: acronymMatches,
    pauseSegments: segments.length,
    averageSegmentChars: avgSegmentChars,
  };

  // Score
  let score = 100;
  const issues: string[] = [];

  if (wpm > 0) {
    if (wpm > 220) { score -= 25; issues.push(`Speech rate ${wpm} WPM is too fast (natural is 140–180)`); }
    else if (wpm < 100) { score -= 15; issues.push(`Speech rate ${wpm} WPM is too slow`); }
  }
  if (punctDensity < 2 && charCount > 80) {
    score -= 15; issues.push('Low punctuation density — TTS likely missing prosody cues');
  }
  if (acronymMatches > 0) {
    score -= Math.min(20, acronymMatches * 5);
    issues.push(`${acronymMatches} acronym(s) over-pronounced letter-by-letter`);
  }
  if (avgSegmentChars > 280 && segments.length > 0) {
    score -= 10; issues.push('Very long sentences without pauses — sounds breathless');
  }
  score = Math.max(0, Math.min(100, score));

  let rating: TtsQualityReport['rating'];
  if (score >= 85) rating = 'natural';
  else if (score >= 65) rating = 'acceptable';
  else if (score >= 35) rating = 'robotic';
  else rating = 'unintelligible';

  return { score, rating, signals, issues };
}

/**
 * Item 8: ASR quality - approximate by comparing what the caller WAS supposed
 * to say (the test scenario script) to what the agent's transcript shows.
 *
 * Returns a string-similarity score + flagged drift instances.
 */
export interface AsrQualityReport {
  similarity: number; // 0-100
  rating: 'excellent' | 'good' | 'fair' | 'poor';
  driftedWordCount: number;
  driftedWords: string[];
  notes: string[];
}

function tokenize(s: string): string[] {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
}

export function evaluateAsrQuality(expectedScript: string, actualTranscript: string): AsrQualityReport {
  const expected = tokenize(expectedScript);
  const actual = tokenize(actualTranscript);
  if (expected.length === 0) {
    return { similarity: 0, rating: 'poor', driftedWordCount: 0, driftedWords: [], notes: ['no expected script'] };
  }
  const actualSet = new Set(actual);
  let matches = 0;
  const drifted: string[] = [];
  for (const w of expected) {
    if (actualSet.has(w)) matches++;
    else drifted.push(w);
  }
  const similarity = Math.round((matches * 100) / expected.length);
  let rating: AsrQualityReport['rating'];
  if (similarity >= 90) rating = 'excellent';
  else if (similarity >= 75) rating = 'good';
  else if (similarity >= 50) rating = 'fair';
  else rating = 'poor';
  const notes: string[] = [];
  if (drifted.length > 5) notes.push(`${drifted.length} words missing — possibly noise or mumbling`);
  return { similarity, rating, driftedWordCount: drifted.length, driftedWords: drifted.slice(0, 20), notes };
}
