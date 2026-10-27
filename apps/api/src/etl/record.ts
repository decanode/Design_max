import 'dotenv/config';
import { OpenAIEmbedder } from './vectorize.js';
import { RecordedEmbedder } from './recorded.js';
import { EMBEDDING_TEXTS, EMBEDDINGS_FILE } from './fixtures/embeddingTexts.js';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required (one-time recording).');
const n = await RecordedEmbedder.record(EMBEDDINGS_FILE, new OpenAIEmbedder(process.env.OPENAI_API_KEY), EMBEDDING_TEXTS);
console.log(`recorded ${n} new embeddings -> ${EMBEDDINGS_FILE}`);
