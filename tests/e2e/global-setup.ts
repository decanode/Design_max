import { execFileSync } from 'node:child_process';

// Runs as a separate process: the migration code is ESM and Playwright loads this file as CommonJS.
export default function globalSetup() {
  execFileSync('npx', ['tsx', 'src/testdb-cli.ts'], { cwd: 'apps/api', stdio: 'inherit' });
}
