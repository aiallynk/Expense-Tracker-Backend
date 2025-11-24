#!/usr/bin/env node

/**
 * Generate secure JWT secrets for production use
 * 
 * Usage: node scripts/generate-jwt-secrets.js
 * 
 * This script generates two secure random strings suitable for JWT secrets.
 * Each secret is 64 characters long (base64 encoded), which is well above
 * the 32 character minimum requirement.
 */

const crypto = require('crypto');

// Generate a secure random string
function generateSecret(length = 64) {
  return crypto.randomBytes(length).toString('base64');
}

// Generate JWT secrets
const accessSecret = generateSecret(64);
const refreshSecret = generateSecret(64);

console.log('\n🔐 JWT Secrets Generated\n');
console.log('='.repeat(70));
console.log('\n📋 Add these to your .env file or Render environment variables:\n');
console.log(`JWT_ACCESS_SECRET=${accessSecret}`);
console.log(`JWT_REFRESH_SECRET=${refreshSecret}`);
console.log('\n' + '='.repeat(70));
console.log('\n⚠️  IMPORTANT SECURITY NOTES:\n');
console.log('1. Keep these secrets secure - never commit them to git');
console.log('2. Use different secrets for development and production');
console.log('3. Store them in Render Dashboard → Environment Variables');
console.log('4. Minimum length: 32 characters (these are 64 characters)');
console.log('5. If you lose these, generate new ones and update all tokens\n');

// Also save to a file (gitignored) for convenience
const fs = require('fs');
const path = require('path');

const secretsFile = path.join(__dirname, '..', '.jwt-secrets.txt');
const content = `# JWT Secrets - Generated on ${new Date().toISOString()}
# ⚠️  DO NOT COMMIT THIS FILE TO GIT
# Add these to your .env file or Render environment variables

JWT_ACCESS_SECRET=${accessSecret}
JWT_REFRESH_SECRET=${refreshSecret}
`;

fs.writeFileSync(secretsFile, content);
console.log(`✅ Secrets also saved to: ${secretsFile}`);
console.log('   (This file is gitignored - safe to keep locally)\n');

