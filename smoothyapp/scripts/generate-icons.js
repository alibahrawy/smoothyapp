/**
 * Generate app icons from SVG source
 * Run with: node scripts/generate-icons.js
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// SmoothyEdit logo SVG (smoothie cup icon)
const svgIcon = `<svg viewBox="0 0 400.354 400.354" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#4ade80;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#22c55e;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="400.354" height="400.354" rx="80" fill="#1a1a2e"/>
  <g transform="translate(50, 30) scale(0.75)" fill="url(#grad)">
    <path d="M314.671,23.379l-9.26-20.149c-1.278-2.783-4.568-4-7.353-2.723l-55.668,25.58c-0.916,0.42-1.697,1.082-2.265,1.913
      l-29.18,42.757c-4.76-1.243-9.748-1.916-14.896-1.916c-25.453,0-47.123,16.176-55.306,38.806h-38.938
      c-9.185,0-16.631,7.446-16.631,16.631v58.109c0,9.185,7.446,16.631,16.631,16.631h7.703l13.407,185.901
      c0.626,8.699,7.866,15.435,16.588,15.435h113.092c8.72,0,15.961-6.734,16.588-15.435l13.406-185.901h7.703
      c9.185,0,16.631-7.446,16.631-16.631v-58.109c0-9.185-7.446-16.631-16.631-16.631h-38.939c-2.654-7.343-6.736-14.001-11.9-19.652
      L263.267,53.1l48.68-22.369c1.338-0.614,2.374-1.733,2.887-3.112C315.343,26.24,315.285,24.715,314.671,23.379z M163.166,369.308
      c-6.581,0.482-12.189-4.506-12.653-10.948l-7.099-98.438c-0.228-3.151,0.786-6.205,2.854-8.594
      c2.068-2.391,4.943-3.831,8.096-4.059c0.288-0.021,0.574-0.032,0.857-0.032c6.169,0,11.351,4.823,11.793,10.98l7.098,98.438
      C174.584,363.166,169.672,368.839,163.166,369.308z"/>
  </g>
</svg>`;

const buildDir = path.join(__dirname, '..', 'build');

// Ensure build directory exists
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

async function generateIcons() {
  console.log('Generating icons...');

  // Generate 1024x1024 PNG
  const pngPath = path.join(buildDir, 'icon.png');
  await sharp(Buffer.from(svgIcon))
    .resize(1024, 1024)
    .png()
    .toFile(pngPath);
  console.log('Created: icon.png (1024x1024)');

  // Generate 256x256 PNG for Windows
  const png256Path = path.join(buildDir, 'icon-256.png');
  await sharp(Buffer.from(svgIcon))
    .resize(256, 256)
    .png()
    .toFile(png256Path);
  console.log('Created: icon-256.png (256x256)');

  // Generate various sizes for ICO
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = [];

  for (const size of sizes) {
    const buffer = await sharp(Buffer.from(svgIcon))
      .resize(size, size)
      .png()
      .toBuffer();
    pngBuffers.push({ size, buffer });

    // Also save individual PNGs for electron-icon-builder
    const sizePath = path.join(buildDir, `icon-${size}.png`);
    await sharp(Buffer.from(svgIcon))
      .resize(size, size)
      .png()
      .toFile(sizePath);
  }

  console.log('Generated all PNG sizes');

  // Create ICO file manually (Windows icon format)
  // ICO format: header + directory entries + image data
  const icoPath = path.join(buildDir, 'icon.ico');
  const icoBuffer = createIco(pngBuffers);
  fs.writeFileSync(icoPath, icoBuffer);
  console.log('Created: icon.ico');

  // Generate .icns for macOS (only on macOS where iconutil is available)
  if (process.platform === 'darwin') {
    console.log('Generating .icns for macOS...');
    const iconsetDir = path.join(buildDir, 'icon.iconset');
    if (!fs.existsSync(iconsetDir)) {
      fs.mkdirSync(iconsetDir, { recursive: true });
    }

    // macOS iconset requires specific filenames and sizes
    const iconsetSizes = [
      { name: 'icon_16x16.png', size: 16 },
      { name: 'icon_16x16@2x.png', size: 32 },
      { name: 'icon_32x32.png', size: 32 },
      { name: 'icon_32x32@2x.png', size: 64 },
      { name: 'icon_128x128.png', size: 128 },
      { name: 'icon_128x128@2x.png', size: 256 },
      { name: 'icon_256x256.png', size: 256 },
      { name: 'icon_256x256@2x.png', size: 512 },
      { name: 'icon_512x512.png', size: 512 },
      { name: 'icon_512x512@2x.png', size: 1024 }
    ];

    for (const entry of iconsetSizes) {
      await sharp(Buffer.from(svgIcon))
        .resize(entry.size, entry.size)
        .png()
        .toFile(path.join(iconsetDir, entry.name));
    }

    // Convert .iconset to .icns using macOS iconutil
    const { execSync } = require('child_process');
    const icnsPath = path.join(buildDir, 'icon.icns');
    try {
      execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`);
      console.log('Created: icon.icns');
      // Clean up .iconset folder
      fs.rmSync(iconsetDir, { recursive: true });
    } catch (err) {
      console.error('Failed to create .icns:', err.message);
    }
  } else {
    console.log('Skipping .icns generation (not on macOS)');
  }

  console.log('\\nIcon generation complete!');
  console.log('Icons saved to:', buildDir);
}

function createIco(images) {
  // ICO file format
  // Header: 6 bytes
  // Directory entries: 16 bytes each
  // Image data: PNG data for each image

  const headerSize = 6;
  const dirEntrySize = 16;
  const numImages = images.length;

  // Calculate total size
  let totalSize = headerSize + (dirEntrySize * numImages);
  const imageOffsets = [];

  for (const img of images) {
    imageOffsets.push(totalSize);
    totalSize += img.buffer.length;
  }

  const buffer = Buffer.alloc(totalSize);
  let offset = 0;

  // ICO Header
  buffer.writeUInt16LE(0, offset); offset += 2; // Reserved
  buffer.writeUInt16LE(1, offset); offset += 2; // Type: 1 = ICO
  buffer.writeUInt16LE(numImages, offset); offset += 2; // Number of images

  // Directory entries
  for (let i = 0; i < numImages; i++) {
    const img = images[i];
    const size = img.size === 256 ? 0 : img.size; // 256 is stored as 0

    buffer.writeUInt8(size, offset); offset += 1; // Width
    buffer.writeUInt8(size, offset); offset += 1; // Height
    buffer.writeUInt8(0, offset); offset += 1; // Color palette
    buffer.writeUInt8(0, offset); offset += 1; // Reserved
    buffer.writeUInt16LE(1, offset); offset += 2; // Color planes
    buffer.writeUInt16LE(32, offset); offset += 2; // Bits per pixel
    buffer.writeUInt32LE(img.buffer.length, offset); offset += 4; // Image size
    buffer.writeUInt32LE(imageOffsets[i], offset); offset += 4; // Image offset
  }

  // Image data
  for (const img of images) {
    img.buffer.copy(buffer, offset);
    offset += img.buffer.length;
  }

  return buffer;
}

generateIcons().catch(console.error);
