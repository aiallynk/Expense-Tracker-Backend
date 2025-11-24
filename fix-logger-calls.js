const fs = require('fs');
const path = require('path');
const glob = require('glob');

// Pattern to match logger calls with message first, then object
// logger.error('message', { ... }) -> logger.error({ ... }, 'message')
const loggerCallPattern = /logger\.(error|warn|info|debug|fatal)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*({[^}]+}|error|error\s*as\s*any|error\s*:\s*any)\s*\)/g;

// More comprehensive pattern that handles multiline
const loggerCallPatternMultiline = /logger\.(error|warn|info|debug|fatal)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([\s\S]*?)\)/g;

function fixLoggerCalls(content) {
  let modified = content;
  
  // Fix simple cases: logger.error('message', error)
  modified = modified.replace(
    /logger\.(error|warn|info|debug|fatal)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(error|error\s*as\s*any|error\s*:\s*any)\s*\)/g,
    (match, level, message, errorVar) => {
      return `logger.${level}({ error: ${errorVar} }, '${message}')`;
    }
  );
  
  // Fix cases with object literals: logger.error('message', { ... })
  // This is more complex and requires careful parsing
  const lines = modified.split('\n');
  const fixedLines = [];
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i];
    
    // Check if this line starts a logger call with message first
    const loggerMatch = line.match(/logger\.(error|warn|info|debug|fatal)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*({)/);
    
    if (loggerMatch) {
      const level = loggerMatch[1];
      const message = loggerMatch[2];
      let braceCount = 1;
      let objectContent = '{';
      let j = i + 1;
      
      // Collect the object content
      while (j < lines.length && braceCount > 0) {
        const currentLine = lines[j];
        objectContent += '\n' + currentLine;
        braceCount += (currentLine.match(/{/g) || []).length;
        braceCount -= (currentLine.match(/}/g) || []).length;
        j++;
      }
      
      // Extract just the object part (remove the opening brace from the first line)
      const objectPart = objectContent.substring(1); // Remove the '{' we added
      
      // Reconstruct the logger call
      fixedLines.push(`logger.${level}({`);
      // Add the object content with proper indentation
      const objectLines = objectPart.split('\n');
      objectLines.forEach((objLine, idx) => {
        if (idx < objectLines.length - 1) {
          fixedLines.push(objLine);
        }
      });
      fixedLines.push(`}, '${message}')`);
      
      i = j;
    } else {
      fixedLines.push(line);
      i++;
    }
  }
  
  return fixedLines.join('\n');
}

// Process all TypeScript files
const files = glob.sync('src/**/*.ts', { cwd: __dirname });

let totalFixed = 0;

files.forEach(file => {
  const filePath = path.join(__dirname, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const fixed = fixLoggerCalls(content);
  
  if (content !== fixed) {
    fs.writeFileSync(filePath, fixed, 'utf8');
    console.log(`Fixed: ${file}`);
    totalFixed++;
  }
});

console.log(`\nFixed ${totalFixed} files`);

