import { pool } from './db.js';
import { migrate } from './migrate.js';

await migrate(pool, console.log);
await pool.end();
