/** Every text the semantic tests embed. `npm run embeddings:record` records these with a real model. */
export const EMBEDDING_TEXTS = [
  'Printer down\nReplaced fuser unit on label printer',
  'Story 1\nFixed by rebuilding the MM01 material master BAPI wrapper\nGiven a vendor, when saved, then an SAP LIFNR is returned',
  'label printer fuser problem',
  'ABAP program ZMM_VENDOR_UPLOAD (type 1, author JDOE)\nTransactions: ZVU1\nUsage count: 420',
  'vendor upload program',
];
export const EMBEDDINGS_FILE = new URL('./embeddings.recorded.json', import.meta.url).pathname;
