#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const piexif = require('piexifjs');
const packageJson = require('./package.json');

if (process.argv.includes('--version')) {
  console.log(`checkimg-speed-dupe version: ${packageJson.version}`);
  process.exit(0);
}

if (process.argv.length !== 5) {
  console.error('Usage: node checkimg_speed_dupe.js <inputFolder> <outputFolder> <minKph>');
  process.exit(1);
}

const inputFolder = path.resolve(process.argv[2]);
const outputFolder = path.resolve(process.argv[3]);
const minKph = parseFloat(process.argv[4]);

if (!Number.isFinite(minKph) || minKph < 0) {
  console.error('minKph must be a non-negative number');
  process.exit(1);
}

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

const convertDMSToDD = (dmsArray, ref) => {
  if (!Array.isArray(dmsArray) || dmsArray.length !== 3) {
    return null;
  }

  const degrees = dmsArray[0][0] / dmsArray[0][1];
  const minutes = dmsArray[1][0] / dmsArray[1][1] / 60;
  const seconds = dmsArray[2][0] / dmsArray[2][1] / 3600;

  let dd = degrees + minutes + seconds;

  if (ref === 'S' || ref === 'W') {
    dd = -dd;
  }

  return dd;
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

const getTimestamp = (exifData) => {
  if (!exifData['Exif']) return null;
  const datetime = exifData['Exif'][piexif.ExifIFD.DateTimeOriginal]
    || exifData['0th'][piexif.ImageIFD.DateTime];
  return datetime ? parseExifDateTime(datetime) : null;
};

const getCoordinates = (exifData) => {
  if (!exifData['GPS']) return null;
  const gps = exifData['GPS'];
  const lat = gps[piexif.GPSIFD.GPSLatitude];
  const lon = gps[piexif.GPSIFD.GPSLongitude];
  const latRef = gps[piexif.GPSIFD.GPSLatitudeRef];
  const lonRef = gps[piexif.GPSIFD.GPSLongitudeRef];

  if (lat && lon) {
    const latitude = convertDMSToDD(lat, latRef);
    const longitude = convertDMSToDD(lon, lonRef);
    return { lat: latitude, lon: longitude };
  }
  return null;
};

const getExifData = (filePath) => {
  try {
    const data = fs.readFileSync(filePath).toString('binary');
    const exifData = piexif.load(data);

    return {
      timestamp: getTimestamp(exifData),
      coordinates: getCoordinates(exifData),
    };
  } catch (err) {
    console.error(`Error reading EXIF: ${err}`);
    return { timestamp: null, coordinates: null };
  }
};

const distanceKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const speedKph = (prev, curr) => {
  const dtMs = curr.time - prev.time;
  if (dtMs <= 0) return null;
  const km = distanceKm(
    prev.coordinates.lat,
    prev.coordinates.lon,
    curr.coordinates.lat,
    curr.coordinates.lon
  );
  return km / (dtMs / (1000 * 3600));
};

const getOutputPath = (inputRoot, outputRoot, folderPath, fileName) => {
  const srcPath = path.join(folderPath, fileName);
  const relativePath = path.relative(inputRoot, srcPath);
  return path.join(outputRoot, relativePath);
};

const processFolder = (folderPath, inputRoot, outputRoot, minKphThreshold) => {
  console.log(`\n=== 處理資料夾: ${folderPath} ===`);

  const files = fs.readdirSync(folderPath)
    .filter(file => file.toLowerCase().endsWith('.jpg'))
    .map(file => {
      const filePath = path.join(folderPath, file);
      const exifInfo = getExifData(filePath);
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

  console.log(`找到 ${files.length} 張圖片，門檻 ${minKphThreshold} kph`);

  let movedCount = 0;

  for (let i = 1; i < files.length; i++) {
    const curr = files[i];

    if (!curr.coordinates) {
      console.log(`Skipping ${curr.name}: missing GPS`);
      continue;
    }

    // Keep the last frame in a slow/stationary run: peel earlier frames one by
    // one, then compare the same curr against the next earlier kept frame (not
    // only the immediate neighbor). Without this, removing one middle frame
    // leaves a gap so the next CLI run finds another slow pair.
    let prevIdx = i - 1;
    while (prevIdx >= 0) {
      const prev = files[prevIdx];

      if (!prev.coordinates) {
        prevIdx--;
        continue;
      }

      const src = path.join(folderPath, prev.name);
      if (!fs.existsSync(src)) {
        prevIdx--;
        continue;
      }

      const speed = speedKph(prev, curr);
      if (speed === null) {
        console.log(`Skipping ${curr.name}: invalid time delta`);
        break;
      }

      if (speed < minKphThreshold) {
        const dest = getOutputPath(inputRoot, outputRoot, folderPath, prev.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(src, dest);
        movedCount++;
        console.log(`Moved: ${prev.name} (${speed.toFixed(2)} kph < ${minKphThreshold})`);
        prevIdx--;
      } else {
        break;
      }
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
  totalMoved += processFolder(folderPath, inputFolder, outputFolder, minKph);
});

console.log(`\n全部完成。共移動 ${totalMoved} 張圖片到 ${outputFolder}`);
