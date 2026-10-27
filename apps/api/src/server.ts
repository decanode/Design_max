import { buildApp } from './app.js';

const port = Number(process.env.API_PORT ?? 4000);
await buildApp().listen({ port, host: '0.0.0.0' });
console.log(`API listening on :${port}`);
