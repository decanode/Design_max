import 'dotenv/config';
import { pool } from '../db.js';
import { JiraExtractor } from './jira.js';
import { ServiceNowExtractor } from './servicenow.js';
import { runMigration } from './pipeline.js';
import { HashEmbedder, OpenAIEmbedder } from './vectorize.js';

// Usage: npm run etl -w apps/api -- <jira|servicenow> <projectId>
const [source, projectId] = process.argv.slice(2);
const env = (k: string) => process.env[k] ?? (() => { throw new Error(`Missing env ${k}`); })();
if (!projectId || !['jira', 'servicenow'].includes(source)) throw new Error('Usage: etl <jira|servicenow> <projectId>');

const extractor = source === 'jira'
  ? new JiraExtractor({ baseUrl: env('JIRA_BASE_URL'), email: env('JIRA_EMAIL'), apiToken: env('JIRA_API_TOKEN'), acceptanceCriteriaField: process.env.JIRA_AC_FIELD })
  : new ServiceNowExtractor({ instanceUrl: env('SNOW_INSTANCE_URL'), username: env('SNOW_USERNAME'), password: env('SNOW_PASSWORD') });
// Falls back to the offline hash embedder when no key is set (vectors are NOT semantically meaningful).
const embedder = process.env.OPENAI_API_KEY ? new OpenAIEmbedder(process.env.OPENAI_API_KEY) : new HashEmbedder();

console.log(await runMigration(pool, projectId, extractor, embedder));
await pool.end();
