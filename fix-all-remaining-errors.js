const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

async function fixAllErrors() {
  const files = await glob('src/**/*.ts', { cwd: __dirname });
  let totalFixed = 0;

  for (const file of files) {
    const filePath = path.join(__dirname, file);
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    // Fix logger calls: logger.level('message', { ... }) -> logger.level({ ... }, 'message')
    // Pattern: logger.(error|warn|info|debug|fatal)('message', { ... })
    const loggerPattern = /logger\.(error|warn|info|debug|fatal)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\{[^}]*\}|error|error\s*as\s*any|error\s*:\s*any)\s*\)/g;
    let match;
    while ((match = loggerPattern.exec(content)) !== null) {
      const [fullMatch, level, message, object] = match;
      const newCall = `logger.${level}(${object}, '${message}')`;
      content = content.replace(fullMatch, newCall);
      modified = true;
    }

    // Fix logger calls with multiline objects - simple cases
    // logger.level('message', { ... }) where object spans multiple lines
    const multilineLoggerPattern = /logger\.(error|warn|info|debug|fatal)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g;
    const lines = content.split('\n');
    const newLines = [];
    let i = 0;
    
    while (i < lines.length) {
      const line = lines[i];
      const multilineMatch = line.match(multilineLoggerPattern);
      
      if (multilineMatch) {
        const level = multilineMatch[1];
        const message = multilineMatch[2];
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
      console.log(`Fixed logger calls in: ${file}`);
      totalFixed++;
    }
  }

  console.log(`\nFixed ${totalFixed} files`);
}

fixAllErrors().catch(console.error);

