require('dotenv').config();
const { Pool } = require('pg');
const OpenAI = require('openai').default;

const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function analyzeCall(row) {
  console.log('Analyzing:', row.id.slice(0, 8));
  const transcript = row.transcript_text || '';
  
  if (!transcript || transcript.length < 10) {
    await pool.query(
      "UPDATE production_calls SET analysis_status = 'completed', overall_score = 50 WHERE id = $1", 
      [row.id]
    );
    console.log('  No transcript, set to 50');
    return;
  }
  
  await pool.query(
    "UPDATE production_calls SET analysis_status = 'analyzing' WHERE id = $1", 
    [row.id]
  );
  
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { 
          role: 'system', 
          content: 'You are a call quality analyst. Rate this voice agent call transcript on a scale of 0-100. Return JSON: {"overallScore": number, "summary": "brief 1-2 sentence summary"}' 
        },
        { role: 'user', content: transcript.substring(0, 2000) }
      ],
      max_tokens: 200,
      temperature: 0.3
    });
    
    const content = response.choices[0]?.message?.content || '{}';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    let analysis = { overallScore: 70, summary: 'Analysis completed' };
    if (jsonMatch) {
      try {
        analysis = JSON.parse(jsonMatch[0]);
      } catch (e) {
        // Extract score from text if JSON parse fails
        const scoreMatch = content.match(/(\d{1,3})/);
        if (scoreMatch) {
          analysis.overallScore = Math.min(100, parseInt(scoreMatch[1]));
        }
      }
    }
    
    await pool.query(
      "UPDATE production_calls SET analysis_status = 'completed', overall_score = $1, analysis = $2 WHERE id = $3",
      [analysis.overallScore || 70, JSON.stringify(analysis), row.id]
    );
    console.log('  Done! Score:', analysis.overallScore);
  } catch (error) {
    console.error('  Error:', error.message);
    await pool.query(
      "UPDATE production_calls SET analysis_status = 'failed' WHERE id = $1", 
      [row.id]
    );
  }
}

async function run() {
  const batchSize = parseInt(process.argv[2]) || 10;
  
  const pending = await pool.query(
    "SELECT id, transcript_text FROM production_calls WHERE analysis_status IN ('pending', 'analyzing') LIMIT $1",
    [batchSize]
  );
  
  console.log(`Processing ${pending.rows.length} calls...\n`);
  
  for (const row of pending.rows) {
    await analyzeCall(row);
  }
  
  const status = await pool.query(
    "SELECT analysis_status, COUNT(*)::int as count FROM production_calls GROUP BY analysis_status ORDER BY analysis_status"
  );
  console.log('\nFinal Status:', status.rows);
  
  await pool.end();
}

run().catch(e => {
  console.error('Fatal error:', e);
  pool.end();
  process.exit(1);
});
