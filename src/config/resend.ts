import { Resend } from 'resend';

import { logger } from './logger';

import { config } from './index';

let resendClient: Resend | null = null;

export const getResendClient = (): Resend | null => {
  if (!resendClient && config.resend.apiKey) {
    try {
      resendClient = new Resend(config.resend.apiKey);
    } catch (error) {
      logger.warn({ error }, 'Resend not initialized - email notifications will be disabled');
      return null;
    }
  }
  return resendClient;
};

export const getFromEmail = (): string => {
  return config.resend.fromEmail;
};

