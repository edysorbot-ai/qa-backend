const pool = require('./dist/db').default;
const fs = require('fs');
const path = require('path');

async function run() {
  const migrationsDir = './dist/db/migrations';
  if (!fs.existsSync(migrationsDir)) {
    console.log('No migrations directory found');
    process.exit(1);
  }
  const migrations = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.js')).sort();
  for (const m of migrations) {
    try {
      const mod = require(path.resolve(migrationsDir, m));
      if (mod.up) {
        await mod.up(pool);
        console.log('OK:', m);
      }
    } catch(e) {
      console.log('SKIP:', m, e.message ? e.message.substring(0, 80) : 'unknown error');
    }
  }
  process.exit(0);
}
run();
