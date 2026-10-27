import { buildApp } from './app.js';
import { attachChat } from './chat/socket.js';
import { defaultObserver, defaultLlm } from './chat/observer.js';

const port = Number(process.env.API_PORT ?? 4000);
const app = buildApp();
await app.ready();
attachChat(app.server, defaultObserver());
await app.listen({ port, host: '0.0.0.0' });
console.log(`API listening on :${port} — AI provider: ${defaultLlm()?.constructor.name ?? 'offline stand-ins'}`);
