import { resetTestDb } from './src/testdb.js';

export default async function setup() {
  await resetTestDb();
}
