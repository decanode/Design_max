import { setDefaultContext } from './src/db.js';

// Test fixtures (creating projects, tickets, users…) are platform-level work. Requests and socket events made by the
// code under test set their own project context, which overrides this, so row-level security is exercised for real.
setDefaultContext({ platform: true });
