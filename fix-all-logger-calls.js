const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

async function fixLoggerCalls() {
  const files = await glob('src/**/*.ts', { cwd: __dirname });
  let totalFixed = 0;

  for (const file of files) {
    const filePath = path.join(__dirname, file);
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
      
      // Check if this line starts a logger call with message first
      const loggerMatch = line.match(/logger\.(error|warn|info|debug|fatal)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*({)/);
      
      if (loggerMatch) {
        const level = loggerMatch[1];
        const message = loggerMatch[2];
        let braceCount = 1;
        let objectLines = [line.substring(0, line.indexOf('{') + 1)];
        let j = i + 1;
        
        // Collect the object content
        while (j < lines.length && braceCount > 0) {
          const currentLine = lines[j];
          objectLines.push(currentLine);
          braceCount += (currentLine.match(/{/g) || []).length;
          braceCount -= (currentLine.match(/}/g) || []).length;
          j++;
        }
        
        // Reconstruct: extract object part and rebuild
        const fullMatch = lines.slice(i, j).join('\n');
        const objectStart = fullMatch.indexOf('{');
        const objectEnd = fullMatch.lastIndexOf('}');
        const objectContent = fullMatch.substring(objectStart, objectEnd + 1);
        const beforeCall = fullMatch.substring(0, fullMatch.indexOf('logger'));
        const afterCall = fullMatch.substring(fullMatch.lastIndexOf(')') + 1);
        
        // Rebuild with correct format
        const newCall = `${beforeCall}logger.${level}(${objectContent}, '${message}')${afterCall}`;
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
      console.log(`Fixed: ${file}`);
      totalFixed++;
    }
  }

  console.log(`\nFixed ${totalFixed} files`);
}

fixLoggerCalls().catch(console.error);

