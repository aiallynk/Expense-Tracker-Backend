import * as admin from 'firebase-admin';

import { logger } from './logger';

import { config } from './index';

let firebaseAdmin: admin.app.App | null = null;

export const initializeFirebase = (): void => {
  if (firebaseAdmin) {
    return;
  }

  // Check if Firebase credentials are properly configured
  const hasProjectId = config.firebase.projectId && config.firebase.projectId.trim() !== '';
  const hasPrivateKey = config.firebase.privateKey && config.firebase.privateKey.trim() !== '';
  const hasClientEmail = config.firebase.clientEmail && config.firebase.clientEmail.trim() !== '';

  if (!hasProjectId || !hasPrivateKey || !hasClientEmail) {
    // Firebase is optional - return silently if not configured
    logger.info('Firebase not configured - push notifications disabled');
    return;
  }

  // Validate private key format - should start with -----BEGIN
  const privateKey = config.firebase.privateKey.trim();
  if (!privateKey.startsWith('-----BEGIN') || !privateKey.includes('PRIVATE KEY')) {
    logger.warn('Firebase private key format is invalid - push notifications disabled');
    return;
  }

  try {
    firebaseAdmin = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: config.firebase.projectId,
        clientEmail: config.firebase.clientEmail,
        privateKey,
      }),
      databaseURL: config.firebase.databaseUrl,
    });
    logger.info('Firebase Admin initialized successfully');
  } catch (error: any) {
    // Log error but don't throw - Firebase is optional
    logger.warn(`Failed to initialize Firebase Admin: ${error.message || error}`);
    logger.info('Continuing without Firebase - push notifications will be disabled');
  }
};

export const getFirebaseAdmin = (): admin.app.App | null => {
  if (!firebaseAdmin) {
    initializeFirebase();
  }
  return firebaseAdmin;
};

export const getMessaging = (): admin.messaging.Messaging | null => {
  const admin = getFirebaseAdmin();
  if (!admin) {
    return null;
  }
  return admin.messaging();
};

