import dotenv from 'dotenv';

dotenv.config();

export const config = {
  app: {
    env: process.env.APP_ENV || 'development',
    port: parseInt(process.env.APP_PORT || '4000', 10),
    frontendUrlApp: process.env.APP_FRONTEND_URL_APP || 'http://localhost:3000',
    frontendUrlAdmin: process.env.APP_FRONTEND_URL_ADMIN || 'http://localhost:3001',
  },
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
    dbName: process.env.MONGODB_DB_NAME || 'expense_tracker',
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'changeme',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'changeme',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    s3Buckets: {
      receipts: process.env.AWS_S3_BUCKET_RECEIPTS || 'expense-receipts-bucket',
      exports: process.env.AWS_S3_BUCKET_EXPORTS || 'expense-exports-bucket',
    },
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    modelVision: process.env.OPENAI_MODEL_VISION || 'gpt-4o',
    modelText: process.env.OPENAI_MODEL_TEXT || 'gpt-4o-mini',
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',
    databaseUrl: process.env.FIREBASE_DATABASE_URL || '',
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    fromEmail: process.env.RESEND_FROM_EMAIL || 'no-reply@aially.in',
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

