#!/usr/bin/env node

/**
 * Script to fix all logger imports to use @/config/logger
 * Also removes console.log/error/warn/debug calls
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function findTsFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory() && !filePath.includes('node_modules') && !filePath.includes('dist')) {
      findTsFiles(filePath, fileList);
    } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
      fileList.push(filePath);
    }
  });
  return fileList;
}

const srcDir = path.join(__dirname, 'src');
const files = findTsFiles(srcDir);

let fixedCount = 0;
let consoleRemovedCount = 0;

files.forEach((filePath) => {
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  // Fix logger imports - various patterns
  const loggerImportPatterns = [
    // Pattern 1: import { logger } from '../utils/logger'
    /import\s+{\s*logger\s*}\s+from\s+['"]\.\.\/utils\/logger['"];?/g,
    // Pattern 2: import { logger } from '../../utils/logger'
    /import\s+{\s*logger\s*}\s+from\s+['"]\.\.\/\.\.\/utils\/logger['"];?/g,
    // Pattern 3: import { logger } from '../../../utils/logger'
    /import\s+{\s*logger\s*}\s+from\s+['"]\.\.\/\.\.\/\.\.\/utils\/logger['"];?/g,
    // Pattern 4: import { logger } from './utils/logger'
    /import\s+{\s*logger\s*}\s+from\s+['"]\.\/utils\/logger['"];?/g,
    // Pattern 5: import { logger } from '../config/logger' (already correct, but ensure @ alias)
    /import\s+{\s*logger\s*}\s+from\s+['"]\.\.\/config\/logger['"];?/g,
    // Pattern 6: import { logger } from './config/logger'
    /import\s+{\s*logger\s*}\s+from\s+['"]\.\/config\/logger['"];?/g,
    // Pattern 7: Dynamic import await import('../utils/logger')
    /await\s+import\(['"]\.\.\/utils\/logger['"]\)/g,
    /await\s+import\(['"]\.\.\/\.\.\/utils\/logger['"]\)/g,
  ];

  loggerImportPatterns.forEach((pattern, index) => {
    if (pattern.test(content)) {
      if (index < 6) {
        content = content.replace(pattern, "import { logger } from '@/config/logger';");
      } else {
        content = content.replace(pattern, "await import('@/config/logger')");
      }
      modified = true;
      fixedCount++;
    }
  });

  // Remove commented-out logger imports
  content = content.replace(/\/\/\s*import\s+{\s*logger\s*}\s+from\s+['"].*utils\/logger['"];?\s*\/\/\s*Unused/g, '');

  // Remove console.log/error/warn/debug (except in env.ts and apiLogger.middleware.ts)
  const fileName = path.basename(filePath);
  if (fileName !== 'env.ts' && fileName !== 'apiLogger.middleware.ts') {
    const consolePatterns = [
      /console\.log\([^)]*\);?\s*/g,
      /console\.error\([^)]*\);?\s*/g,
      /console\.warn\([^)]*\);?\s*/g,
      /console\.debug\([^)]*\);?\s*/g,
      /console\.info\([^)]*\);?\s*/g,
    ];

    consolePatterns.forEach((pattern) => {
      const matches = content.match(pattern);
      if (matches) {
        consoleRemovedCount += matches.length;
        // Replace with logger calls - but be careful not to break code
        // For now, just remove them - we'll add proper logger calls manually where needed
        content = content.replace(pattern, '');
        modified = true;
      }
    });
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ Fixed: ${path.relative(__dirname, filePath)}`);
  }
});

console.log(`\n✅ Fixed ${fixedCount} logger imports`);
console.log(`✅ Removed ${consoleRemovedCount} console.* calls`);
console.log('\n✅ All logger imports fixed!');

