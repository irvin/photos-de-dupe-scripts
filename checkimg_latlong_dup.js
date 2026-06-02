#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const exifParser = require('exif-parser');
const packageJson = require('./package.json');

if (process.argv.includes('--version')) {
  console.log(`checkimg-latlong-dup version: ${packageJson.version}`);
  process.exit(0);
}

if (process.argv.length !== 4) {
  console.error('Usage: node checkimg_latlong_dup.js <inputFolder> <outputFolder>');
  process.exit(1);
}

const inputFolder = path.resolve(process.argv[2]);
const outputFolder = path.resolve(process.argv[3]);

if (!fs.existsSync(outputFolder)) {
  fs.mkdirSync(outputFolder, { recursive: true });
}

const scanDirectory = (dirPath) => {
  const foldersWithJpg = [];

  const scanRecursive = (currentPath) => {
    try {
      const items = fs.readdirSync(currentPath);
      const hasJpgFiles = items.some(item => item.toLowerCase().endsWith('.jpg'));
      const hasSubdirs = items.some(item => {
        const itemPath = path.join(currentPath, item);
        return fs.statSync(itemPath).isDirectory();
      });

      if (hasJpgFiles) {
        foldersWithJpg.push(currentPath);
      }

      if (!hasJpgFiles && hasSubdirs) {
        items.forEach(item => {
          const itemPath = path.join(currentPath, item);
          if (fs.statSync(itemPath).isDirectory()) {
            scanRecursive(itemPath);
          }
        });
      }
    } catch (err) {
      console.error(`Error scanning directory ${currentPath}: ${err.message}`);
    }
  };

  scanRecursive(dirPath);
  return foldersWithJpg;
};

const parseExifDateTime = (exifDateTime) => {
  try {
    const [date, time] = exifDateTime.split(' ');
    const [year, month, day] = date.split(':');
    const [hour, minute, second] = time.split(':');

    return new Date(year, month - 1, day, hour, minute, second).getTime();
  } catch (err) {
    console.error(`Error parsing EXIF datetime: ${exifDateTime}`);
    return null;
  }
};

const getTimestampFromTags = (tags, filePath) => {
  const dt = tags.DateTimeOriginal || tags.CreateDate || tags.ModifyDate;
  if (dt == null) {
    return fs.statSync(filePath).mtime.getTime();
  }
  if (typeof dt === 'number') {
    return dt < 1e12 ? dt * 1000 : dt;
  }
  if (typeof dt === 'string') {
    return parseExifDateTime(dt) || fs.statSync(filePath).mtime.getTime();
  }
  return fs.statSync(filePath).mtime.getTime();
};

const getExifInfo = (filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const parser = exifParser.create(buffer);
    const result = parser.parse();
    const tags = result.tags;
    const coordinates = tags.GPSLatitude != null && tags.GPSLongitude != null
      ? { lat: tags.GPSLatitude, lon: tags.GPSLongitude }
      : null;
    const timestamp = getTimestampFromTags(tags, filePath);

    return { coordinates, timestamp };
  } catch (err) {
    console.error(`Error reading EXIF from ${filePath}: ${err}`);
    return { coordinates: null, timestamp: null };
  }
};

const getOutputPath = (inputRoot, outputRoot, folderPath, fileName) => {
  const srcPath = path.join(folderPath, fileName);
  const relativePath = path.relative(inputRoot, srcPath);
  return path.join(outputRoot, relativePath);
};

const processFolder = (folderPath, inputRoot, outputRoot) => {
  console.log(`\n=== 處理資料夾: ${folderPath} ===`);

  const files = fs.readdirSync(folderPath)
    .filter(file => file.toLowerCase().endsWith('.jpg'))
    .map(file => {
      const filePath = path.join(folderPath, file);
      const exifInfo = getExifInfo(filePath);
      const fileTime = exifInfo.timestamp || fs.statSync(filePath).mtime.getTime();
      return {
        name: file,
        time: fileTime,
        coordinates: exifInfo.coordinates,
      };
    })
    .sort((a, b) => a.time - b.time);

  if (files.length < 2) {
    console.log(`跳過（少於 2 張圖片）: ${folderPath}`);
    return 0;
  }

  console.log(`找到 ${files.length} 張圖片（依 EXIF 時間排序）`);

  let movedCount = 0;

  for (let i = 1; i < files.length; i++) {
    const prev = files[i - 1];
    const curr = files[i];

    if (!prev.coordinates || !curr.coordinates) {
      console.log(`Skipping ${curr.name}: missing GPS`);
      continue;
    }

    console.log(
      `Processing ${curr.name}, current: (${curr.coordinates.lat}, ${curr.coordinates.lon}), ` +
      `previous: (${prev.coordinates.lat}, ${prev.coordinates.lon})`
    );

    if (
      curr.coordinates.lat === prev.coordinates.lat &&
      curr.coordinates.lon === prev.coordinates.lon
    ) {
      const src = path.join(folderPath, prev.name);
      if (!fs.existsSync(src)) {
        console.log(`Already moved: ${prev.name}`);
        continue;
      }

      const dest = getOutputPath(inputRoot, outputRoot, folderPath, prev.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      movedCount++;
      console.log(`Moved: ${prev.name}`);
    }
  }

  console.log(`資料夾 ${folderPath} 完成，移動 ${movedCount} 張。`);
  return movedCount;
};

const foldersToProcess = scanDirectory(inputFolder);

if (foldersToProcess.length === 0) {
  console.log(`在 ${inputFolder} 中沒有找到包含 .jpg 檔案的資料夾。`);
  process.exit(1);
}

console.log(`找到 ${foldersToProcess.length} 個包含圖片的資料夾:`);
foldersToProcess.forEach(folder => {
  console.log(`  - ${folder}`);
});

let totalMoved = 0;
foldersToProcess.forEach(folderPath => {
  totalMoved += processFolder(folderPath, inputFolder, outputFolder);
});

console.log(`\n全部完成。共移動 ${totalMoved} 張圖片到 ${outputFolder}`);
