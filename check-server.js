#!/usr/bin/env node

/**
 * Simple script to check if the backend server is running
 * Usage: node check-server.js [port]
 */

const http = require('http');

const port = process.argv[2] || 4000;
const url = `http://localhost:${port}/health`;

console.log(`Checking server at ${url}...\n`);

const req = http.get(url, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      console.log('✅ Server is running!');
      console.log('\nResponse:');
      console.log(JSON.stringify(result, null, 2));
      
      if (result.database && !result.database.connected) {
        console.log('\n⚠️  Warning: MongoDB is not connected');
        console.log('   Some features may not work. Check your .env file and MongoDB connection.');
      }
    } catch (e) {
      console.log('✅ Server responded but with invalid JSON');
      console.log('Response:', data);
    }
  });
});

req.on('error', (err) => {
  console.error('❌ Server is not running or not reachable');
  console.error(`\nError: ${err.message}`);
  console.error(`\nTo start the server:`);
  console.error(`  1. cd BACKEND`);
  console.error(`  2. npm run dev`);
  console.error(`\nOr if you have a .env file configured:`);
  console.error(`  1. cd BACKEND`);
  console.error(`  2. npm start`);
  process.exit(1);
});

req.setTimeout(5000, () => {
  console.error('❌ Connection timeout');
  console.error('   The server may be slow to respond or not running');
  req.destroy();
  process.exit(1);
});

