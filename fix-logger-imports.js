#!/usr/bin/env node

/**
 * Script to fix logger import paths from ../utils/logger to ../config/logger
 * Run: node fix-logger-imports.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const filesToFix = [
  'src/services/reports.service.ts',
  'src/services/employeeId.service.ts',
  'src/services/businessHead.service.ts',
  'src/services/teams.service.ts',
  'src/services/manager.service.ts',
  'src/services/currency.service.ts',
  'src/socket/socketServer.ts',
  'src/socket/realtimeEvents.ts',
  'src/controllers/manager.controller.ts',
  'src/controllers/companyNotifications.controller.ts',
  'src/services/notificationData.service.ts',
  'src/controllers/companySettings.controller.ts',
  'src/services/companySettings.service.ts',
  'src/controllers/admin.controller.ts',
  'src/services/companyAdminDashboard.service.ts',
  'src/services/systemAnalytics.service.ts',
  'src/services/settings.service.ts',
  'src/services/backup.service.ts',
  'src/services/ocr.service.ts',
  'src/controllers/reports.controller.ts',
  'src/services/notification.service.ts',
];

filesToFix.forEach((file) => {
  const filePath = path.join(__dirname, file);
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    const oldImport = /import\s+{\s*logger\s*}\s+from\s+['"]\.\.\/utils\/logger['"];?/g;
    const newImport = "import { logger } from '../config/logger';";
    
    if (oldImport.test(content)) {
      content = content.replace(oldImport, newImport);
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`✅ Fixed: ${file}`);
    }
  }
});

// Fix users.service.ts dynamic import
const usersServicePath = path.join(__dirname, 'src/services/users.service.ts');
if (fs.existsSync(usersServicePath)) {
  let content = fs.readFileSync(usersServicePath, 'utf8');
  content = content.replace(
    /const\s+{\s*logger\s*}\s+=\s+await\s+import\(['"]\.\.\/utils\/logger['"]\);?/g,
    "const { logger } = await import('../config/logger');"
  );
  fs.writeFileSync(usersServicePath, content, 'utf8');
  console.log('✅ Fixed: src/services/users.service.ts');
}

console.log('\n✅ All logger imports fixed!');

