/**
 * Firebase FCM Topic Utilities
 * Handles topic name generation and validation for broadcast notifications
 */

/**
 * Validates a topic name according to Firebase FCM rules
 * Allowed characters: a-z, A-Z, 0-9, -, _, ~, %, .
 * @param topicName - Topic name to validate
 * @returns true if valid, false otherwise
 */
export const validateTopicName = (topicName: string): boolean => {
  if (!topicName || topicName.length === 0) {
    return false;
  }

  // Firebase topic name rules: a-z, A-Z, 0-9, -, _, ~, %, .
  const topicNameRegex = /^[a-zA-Z0-9\-_~%.]+$/;
  return topicNameRegex.test(topicName);
};

/**
 * Sanitizes a topic name to ensure it's safe for Firebase
 * Replaces invalid characters with underscores
 * @param topicName - Topic name to sanitize
 * @returns Sanitized topic name
 */
export const sanitizeTopicName = (topicName: string): string => {
  if (!topicName) {
    return '';
  }

  // Replace invalid characters with underscore
  return topicName.replace(/[^a-zA-Z0-9\-_~%.]/g, '_');
};

/**
 * Get the topic name for all users
 * @returns "all_users"
 */
export const getAllUsersTopic = (): string => {
  return 'all_users';
};

/**
 * Get the topic name for a specific company
 * @param companyId - Company ID (MongoDB ObjectId string)
 * @returns "company_<companyId>"
 */
export const getCompanyTopic = (companyId: string): string => {
  if (!companyId) {
    throw new Error('Company ID is required');
  }

  // Sanitize companyId to ensure it's safe
  const sanitizedId = sanitizeTopicName(companyId);
  const topicName = `company_${sanitizedId}`;

  if (!validateTopicName(topicName)) {
    throw new Error(`Invalid topic name generated: ${topicName}`);
  }

  return topicName;
};

/**
 * Get the topic name for a specific role (for future use)
 * @param role - User role (e.g., "MANAGER", "EMPLOYEE")
 * @returns "role_<ROLE_NAME>"
 */
export const getRoleTopic = (role: string): string => {
  if (!role) {
    throw new Error('Role is required');
  }

  // Sanitize role to ensure it's safe
  const sanitizedRole = sanitizeTopicName(role.toUpperCase());
  const topicName = `role_${sanitizedRole}`;

  if (!validateTopicName(topicName)) {
    throw new Error(`Invalid topic name generated: ${topicName}`);
  }

  return topicName;
};

/**
 * Parse topic name to extract information
 * @param topicName - Topic name to parse
 * @returns Object with topic type and identifier, or null if invalid
 */
export const parseTopicName = (topicName: string): { type: 'all_users' | 'company' | 'role'; identifier?: string } | null => {
  if (!topicName || !validateTopicName(topicName)) {
    return null;
  }

  if (topicName === 'all_users') {
    return { type: 'all_users' };
  }

  if (topicName.startsWith('company_')) {
    const companyId = topicName.replace('company_', '');
    return { type: 'company', identifier: companyId };
  }

  if (topicName.startsWith('role_')) {
    const role = topicName.replace('role_', '');
    return { type: 'role', identifier: role };
  }

  return null;
};


