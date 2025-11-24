const fs = require('fs');
const path = require('path');

// Get all TypeScript files
function getAllTsFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory() && !file.startsWith('.') && file !== 'node_modules') {
      getAllTsFiles(filePath, fileList);
    } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
      fileList.push(filePath);
    }
  });
  return fileList;
}

const files = getAllTsFiles(path.join(__dirname, 'src'));
let totalFixed = 0;

files.forEach(filePath => {
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  // Pattern 1: logger.level('message', error) -> logger.level({ error }, 'message')
  const pattern1 = /logger\.(error|warn|info|debug|fatal)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(error|error\s*as\s*any|error\s*:\s*any)\s*\)/g;
  if (pattern1.test(content)) {
    content = content.replace(pattern1, (match, level, message, errorVar) => {
      modified = true;
      return `logger.${level}({ error: ${errorVar} }, '${message}')`;
    });
  }

  // Pattern 2: logger.level('message', { ... }) -> logger.level({ ... }, 'message')
  // This is more complex - need to handle multiline objects
  const lines = content.split('\n');
  const newLines = [];
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i];
    // Match logger.level('message', { ... })
    const match = line.match(/logger\.(error|warn|info|debug|fatal)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/);
    
    if (match) {
      const level = match[1];
      const message = match[2];
      let braceCount = 1;
      let objectLines = [];
      let j = i;
      
      // Find the opening brace
      const braceIndex = line.indexOf('{');
      if (braceIndex >= 0) {
        objectLines.push(line.substring(braceIndex));
        
        // Collect object content
        j = i + 1;
        while (j < lines.length && braceCount > 0) {
          const currentLine = lines[j];
          objectLines.push(currentLine);
          braceCount += (currentLine.match(/{/g) || []).length;
          braceCount -= (currentLine.match(/}/g) || []).length;
          j++;
        }
      }
      
      // Reconstruct
      const objectContent = objectLines.join('\n');
      const beforeLogger = line.substring(0, line.indexOf('logger'));
      const newCall = `${beforeLogger}logger.${level}(${objectContent}, '${message}')`;
      newLines.push(newCall);
      modified = true;
      i = j;
    } else {
      newLines.push(line);
      i++;
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
    console.log(`Fixed logger calls in: ${filePath}`);
    totalFixed++;
  }
});

console.log(`\nFixed ${totalFixed} files`);

