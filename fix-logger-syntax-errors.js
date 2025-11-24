const fs = require('fs');
const path = require('path');

const files = [
  'src/services/ocr.service.ts',
  'src/services/receipts.service.ts',
];

files.forEach(file => {
  const filePath = path.join(__dirname, file);
  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;
  
  // Fix });, pattern to },
  const oldPattern = /\}\);,/g;
  if (oldPattern.test(content)) {
    content = content.replace(oldPattern, '},');
    modified = true;
  }
  
  // Fix }, 'message') at end of try-catch blocks that should be inside the try
  // This is a more complex fix - we need to handle the case where }, 'message') appears after a catch block
  // But first, let's fix the simpler cases
  
  if (modified) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed ${file}`);
  }
});

console.log('Done fixing logger syntax errors');

