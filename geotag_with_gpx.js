#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const piexif = require('piexifjs');
const packageJson = require('./package.json');

if (process.argv.includes('--version')) {
  console.log(`geotag_with_gpx version: ${packageJson.version}`);
  process.exit(0);
}

// ----------- 參數處理 -----------
if (process.argv.length < 5 || process.argv.length > 6) {
  console.error('Usage: node geotag_with_gpx.js <inputFolder> <gpxFile> <outputFolder> [timezone]');
  console.error('  timezone: Optional timezone offset (e.g., "+09:00" for JST, "+08:00" for CST)');
  console.error('           If not specified, system timezone will be used');
  process.exit(1);
}

const inputFolder = process.argv[2];
const gpxFile = process.argv[3];
const outputFolder = process.argv[4];
const timezoneArg = process.argv[5]; // 可選的時區參數

// 取得系統時區偏移，格式為 +HH:MM 或 -HH:MM
function getSystemTZOffset() {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

const timezone = timezoneArg || getSystemTZOffset();
const tempFolder = './_temp_nogps';

// ----------- 建立資料夾 -----------
if (!fs.existsSync(tempFolder)) fs.mkdirSync(tempFolder);
if (!fs.existsSync(outputFolder)) fs.mkdirSync(outputFolder);

// ----------- Step 1: 去除 GPS 並複製到暫存資料夾 -----------
const jpgFiles = fs.readdirSync(inputFolder).filter(f => f.toLowerCase().endsWith('.jpg'));

console.log(`Step 1: Stripping GPS from ${jpgFiles.length} images...`);

for (const file of jpgFiles) {
  const inputPath = path.join(inputFolder, file);
  const outputPath = path.join(tempFolder, file);

  const data = fs.readFileSync(inputPath).toString('binary');
  const exifObj = piexif.load(data);

  delete exifObj['GPS']; // 清除 GPS 欄位

  const newData = piexif.insert(piexif.dump(exifObj), data);
  fs.writeFileSync(outputPath, Buffer.from(newData, 'binary'));
}

// ----------- Step 2: Geotag 使用 exiftool -----------
console.log('Step 2: Running exiftool geotag...');
console.log(`  Photo timezone: ${timezone}`);

try {
  execSync(`exiftool -r \
    -geotag "${gpxFile}" \
    -ext jpg \
    -overwrite_original \
    -api GeoMaxIntSecs=3 -api GeoMaxExtSecs=0 \
    '-geotime<\${DateTimeOriginal}${timezone}' \
    "${tempFolder}"`, { stdio: 'inherit' });
} catch (err) {
  console.error('❌ Exiftool geotag failed:', err.message);
  process.exit(1);
}

// ----------- Step 3: 搬移成功 geotag 的照片到輸出資料夾 -----------
console.log('Step 3: Copying matched images to output folder...');

try {
  execSync(`exiftool -r \
    -if '$gpslatitude and $gpslongitude' \
    -ext jpg \
    -o "${outputFolder}" \
    "${tempFolder}"`, { stdio: 'inherit' });
} catch (err) {
  console.error('❌ Exiftool copy failed:', err.message);
  process.exit(1);
}

// ----------- Step 4: 刪除暫存資料夾 -----------
console.log(`Step 4: Cleaning up temp folder (${tempFolder})...`);
fs.rmSync(tempFolder, { recursive: true, force: true });

console.log(`✅ Done. Output saved to: ${outputFolder}`);