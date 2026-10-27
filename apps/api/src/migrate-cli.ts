import pg from 'pg';
import { migrationUrl } from './db.js';
import { migrate } from './migrate.js';

// Migrations run as the database owner, never as the restricted application account.
const owner = new pg.Pool({ connectionString: migrationUrl() });
await migrate(owner, console.log);
await owner.end();
