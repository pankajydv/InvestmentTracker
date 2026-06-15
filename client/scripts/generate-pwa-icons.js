#!/usr/bin/env node

/**
 * PWA Icon Generator Script
 * Generates placeholder PNG icons for PWA manifest
 * 
 * Usage: node generate-pwa-icons.js
 * 
 * Prerequisites:
 * - Install sharp: npm install --save-dev sharp
 * - Or use ImageMagick: convert -density X -resize WxH
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outputDir = path.join(__dirname, '..', 'public', 'icons');
const faviconPath = path.join(__dirname, '..', 'public', 'favicon.svg');

// Check if Sharp is available, otherwise provide instructions
async function generateWithSharp() {
  try {
    const sharp = (await import('sharp')).default;
    if (!fs.existsSync(faviconPath)) {
      console.error(`Missing source icon: ${faviconPath}`);
      return;
    }

    const baseSvg = fs.readFileSync(faviconPath);
    
    const sizes = [
      { name: 'icon-192x192.png', size: 192 },
      { name: 'icon-512x512.png', size: 512 },
      { name: 'icon-maskable-192x192.png', size: 192 },
      { name: 'icon-maskable-512x512.png', size: 512 },
    ];

    sizes.forEach(({ name, size }) => {
      sharp(baseSvg)
        .resize(size, size)
        .png()
        .toFile(path.join(outputDir, name), (err, info) => {
          if (err) {
            console.error(`❌ Failed to generate ${name}:`, err.message);
          } else {
            console.log(`✅ Generated ${name} (${info.size} bytes)`);
          }
        });
    });
  } catch (e) {
    console.error('Sharp not installed. Install with: npm install --save-dev sharp');
    printAlternatives();
  }
}

function printAlternatives() {
  console.log(`
📋 Manual Icon Generation Options:

1. **Using ImageMagick (if installed)**:
   convert -density 1024 -resize 192x192 public/favicon.svg public/icons/icon-192x192.png
   convert -density 2560 -resize 512x512 public/favicon.svg public/icons/icon-512x512.png

2. **Using Online Tools**:
   - Convertio: https://convertio.co/svg-png/
   - CloudConvert: https://cloudconvert.com/svg-to-png
   - Favicon.io: https://favicon.io/

3. **Using Figma**:
   - Upload favicon.svg
   - Export as PNG at 192x192 and 512x512

4. **Using Paint.NET or Photoshop**:
   - Open favicon.svg
   - Export as PNG at each size

💡 Tip: Maskable icons are identical to regular icons in this template
  but should have transparent edges if you want a custom shape.
  For now, duplicating the regular icon works fine.
`);
}

// Create output directory if it doesn't exist
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log('🎨 PWA Icon Generator');
console.log('====================');
console.log(`Output directory: ${outputDir}`);
console.log('');

(async () => {
  await generateWithSharp();
})();
