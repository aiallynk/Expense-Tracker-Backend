/**
 * Script to generate test users for load testing
 * 
 * Usage:
 *   node scripts/generate-test-users.js [count] [output-file]
 * 
 * Example:
 *   node scripts/generate-test-users.js 100000 data/test-users.json
 */

const fs = require('fs');
const path = require('path');

// Get command line arguments
const count = parseInt(process.argv[2] || '100000', 10);
const outputFile = process.argv[3] || path.join(__dirname, '../data/test-users.json');

// Generate users
const users = [];
for (let i = 0; i < count; i++) {
  users.push({
    email: `loadtest${i}@test.nexpense.com`,
    password: `TestPassword${i}!`,
    name: `Load Test User ${i}`,
  });
}

// Write to file
const outputDir = path.dirname(outputFile);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(outputFile, JSON.stringify(users, null, 2));

console.log(`Generated ${count} test users in ${outputFile}`);
console.log(`\nIMPORTANT: These users must be seeded in your database before running load tests.`);
console.log(`Use the backend's seed script or API to create these users.`);
