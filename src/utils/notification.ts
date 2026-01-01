import { getMessaging } from '../config/firebase';
import { logger } from '../config/logger';

interface SendNotificationParams {
  tokens: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
}

export const sendPushNotification = async ({
  tokens,
  title,
  body,
  data = {},
}: SendNotificationParams): Promise<void> => {
  const messaging = getMessaging();

  if (!messaging) {
    logger.info('Firebase messaging not available – skipping push notification');
    return;
  }

  if (!tokens || tokens.length === 0) {
    return;
  }

  try {
    await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title,
        body,
      },
      data,
    });

    logger.info(`Push notification sent to ${tokens.length} devices`);
  } catch (error: any) {
    logger.error(`Failed to send push notification: ${error.message}`);
  }
};
