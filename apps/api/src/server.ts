import { buildApp } from './app.js';
import { attachChat } from './chat/socket.js';
import { attachCollab } from './collab/server.js';
import { defaultLlm } from './chat/llm.js';
import { LlmChatAgent, ScriptedChatAgent } from './chat/agent.js';
import { defaultEmbedder } from './etl/vectorize.js';

const port = Number(process.env.API_PORT ?? 4000);
const app = buildApp();
await app.ready();
const llm = defaultLlm();
attachChat(app.server, llm ? new LlmChatAgent(llm) : new ScriptedChatAgent(), defaultEmbedder());
attachCollab(app.server);
await app.listen({ port, host: '0.0.0.0' });
console.log(`API listening on :${port} — AI provider: ${defaultLlm()?.constructor.name ?? 'offline stand-ins'}`);
