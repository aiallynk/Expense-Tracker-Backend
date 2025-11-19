#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Check if dist/server.js exists
const serverPath = path.join(__dirname, 'dist', 'server.js');

if (!fs.existsSync(serverPath)) {
  console.error('ERROR: Cannot find dist/server.js');
  console.error('Current directory:', __dirname);
  console.error('Looking for:', serverPath);
  
  // List current directory
  try {
    const files = fs.readdirSync(__dirname);
    console.error('\nFiles in current directory:', files.join(', '));
  } catch (err) {
    console.error('Cannot read current directory:', err.message);
  }
  
  // Check if dist folder exists
  const distPath = path.join(__dirname, 'dist');
  if (fs.existsSync(distPath)) {
    try {
      const distFiles = fs.readdirSync(distPath);
      console.error('\nFiles in dist folder:', distFiles.join(', '));
    } catch (err) {
      console.error('Cannot read dist directory:', err.message);
    }
  } else {
    console.error('\nERROR: dist folder does not exist!');
    console.error('Build may have failed. Check build logs.');
  }
  
  process.exit(1);
}

// Start the server with memory limit
console.log('Starting server from:', serverPath);
console.log('Memory limit: 1024MB');

// Use relative path to avoid issues with spaces in absolute paths on Windows
const relativeServerPath = path.relative(__dirname, serverPath);

// Spawn node process with memory limit (cross-platform compatible)
const nodeArgs = ['--max-old-space-size=1024', relativeServerPath];
const nodeProcess = spawn('node', nodeArgs, {
  stdio: 'inherit',
  shell: true,
  cwd: __dirname  // Set working directory explicitly
});

nodeProcess.on('error', (error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

nodeProcess.on('exit', (code) => {
  process.exit(code || 0);
});

