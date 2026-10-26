import path from 'node:path';

// Tests always use the embedded MongoDB and a throwaway secret. Never point a test run at a
// real database: the integration suites create and drop organizations.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-that-is-not-used-anywhere-real';
process.env.MONGOMS_DOWNLOAD_DIR = process.env.MONGOMS_DOWNLOAD_DIR || path.resolve(__dirname, '../../../.mongodb-binaries');
process.env.STORAGE_LOCAL_DIR = './data/test-uploads';
process.env.MAIL_DRIVER = 'file';
process.env.AI_PROVIDER = 'heuristic';
delete process.env.MONGODB_URI;
