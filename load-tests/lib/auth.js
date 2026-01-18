/**
 * Authentication helper functions for k6 load tests
 */

import http from 'k6/http';

/**
 * Login and retrieve access token
 * @param {string} baseUrl - Base URL of the API
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Object} - Object containing accessToken and refreshToken
 */
export function login(baseUrl, email, password) {
  const response = http.post(`${baseUrl}/api/v1/auth/login`, JSON.stringify({
    email: email,
    password: password,
  }), {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 200) {
    const body = JSON.parse(response.body);
    if (body.success && body.data && body.data.tokens) {
      return {
        accessToken: body.data.tokens.accessToken,
        refreshToken: body.data.tokens.refreshToken,
        user: body.data.user,
      };
    }
  }

  return null;
}

/**
 * Refresh access token using refresh token
 * @param {string} baseUrl - Base URL of the API
 * @param {string} refreshToken - Refresh token
 * @returns {string|null} - New access token or null if failed
 */
export function refreshToken(baseUrl, refreshToken) {
  const response = http.post(`${baseUrl}/api/v1/auth/refresh`, JSON.stringify({
    refreshToken: refreshToken,
  }), {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 200) {
    const body = JSON.parse(response.body);
    if (body.success && body.data && body.data.accessToken) {
      return body.data.accessToken;
    }
  }

  return null;
}

/**
 * Get Authorization header with Bearer token
 * @param {string} accessToken - Access token
 * @returns {Object} - Headers object with Authorization
 */
export function getAuthHeaders(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Authenticate and return headers for authenticated requests
 * @param {string} baseUrl - Base URL of the API
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Object|null} - Headers object or null if authentication failed
 */
export function authenticate(baseUrl, email, password) {
  const authResult = login(baseUrl, email, password);
  if (authResult && authResult.accessToken) {
    return getAuthHeaders(authResult.accessToken);
  }
  return null;
}
