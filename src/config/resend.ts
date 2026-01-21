import { Resend } from 'resend';

import { logger } from './logger';

import { config } from './index';

let resendClient: Resend | null = null;

export const getResendClient = (): Resend | null => {
  if (!config.resend.apiKey) {
    logger.warn('RESEND_API_KEY not configured - email notifications will be disabled');
    return null;
  }

  if (!resendClient) {
    try {
      resendClient = new Resend(config.resend.apiKey);
      logger.info('Resend client initialized successfully');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Resend client - email notifications will be disabled');
      return null;
    }
  }
  return resendClient;
};

export const getFromEmail = (): string => {
  const email = config.resend.fromEmail;
  // Format as "Nexpense <email@domain>" for better email display
  return `Nexpense <${email}>`;
};

