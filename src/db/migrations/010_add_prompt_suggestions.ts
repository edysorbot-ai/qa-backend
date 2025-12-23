import { query } from '../index';

export async function addPromptSuggestionsColumn() {
  try {
    console.log('Adding prompt_suggestions column to test_results table...');
    
    await query(`
      ALTER TABLE test_results 
      ADD COLUMN IF NOT EXISTS prompt_suggestions JSONB DEFAULT '[]'::jsonb
    `);
    
    console.log('✅ Prompt suggestions column added successfully');
  } catch (error) {
    console.error('Error adding prompt_suggestions column:', error);
    throw error;
  }
}
