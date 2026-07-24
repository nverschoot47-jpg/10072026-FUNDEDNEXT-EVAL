import { initSchema, pool } from './db.js';
await initSchema();
console.log('[Migrate] klaar');
await pool.end();
