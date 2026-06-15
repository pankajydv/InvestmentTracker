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

// Simple SVG to use as base (blue gradient with chart icon)
const baseSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0066cc;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0052a3;stop-opacity:1" />
    </linearGradient>
  </defs>
  <!-- Background -->
  <rect width="512" height="512" fill="url(#grad1)"/>
  <!-- Chart bars -->
  <rect x="100" y="300" width="60" height="150" fill="white" opacity="0.9"/>
  <rect x="200" y="200" width="60" height="250" fill="white" opacity="0.8"/>
  <rect x="300" y="100" width="60" height="350" fill="white" opacity="0.7"/>
</svg>`;

const outputDir = path.join(__dirname, 'public', 'icons');
const faviconPath = path.join(__dirname, 'public', 'favicon.svg');

// Check if Sharp is available, otherwise provide instructions
async function generateWithSharp() {
  try {
    const sharp = (await import('sharp')).default;
    
    const sizes = [
      { name: 'icon-192x192.png', size: 192 },
      { name: 'icon-512x512.png', size: 512 },
      { name: 'icon-maskable-192x192.png', size: 192 },
      { name: 'icon-maskable-512x512.png', size: 512 },
    ];

    sizes.forEach(({ name, size }) => {
      const svgBuffer = Buffer.from(baseSvg);
      sharp(svgBuffer)
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
