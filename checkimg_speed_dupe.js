#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const piexif = require('piexifjs');
const packageJson = require('./package.json');

const SPLIT_TIME_SEC = 30;

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

/**
 * Split sorted files into continuous sequences by adjacent capture time gaps.
 * @returns {{ sequences: object[][], timeGapSplits: number }}
 */
const splitIntoSequences = (files, splitTimeSec = SPLIT_TIME_SEC) => {
  if (files.length === 0) {
    return { sequences: [], timeGapSplits: 0 };
  }

  const maxGapMs = splitTimeSec * 1000;
  const sequences = [[files[0]]];
  let timeGapSplits = 0;

  for (let i = 1; i < files.length; i++) {
    const prev = files[i - 1];
    const curr = files[i];
    const dtMs = curr.time - prev.time;

    if (dtMs > 0 && dtMs <= maxGapMs) {
      sequences[sequences.length - 1].push(curr);
    } else {
      sequences.push([curr]);
      timeGapSplits++;
    }
  }

  return { sequences, timeGapSplits };
};

/**
 * Mark earlier photos in adjacent slow pairs within each sequence.
 * @returns {{ toRemove: Set<string>, unmeasurablePairs: number }}
 */
const markPhotosToRemove = (sequences, minKphThreshold) => {
  const toRemove = new Set();
  let unmeasurablePairs = 0;

  for (const sequence of sequences) {
    for (let i = 1; i < sequence.length; i++) {
      const prev = sequence[i - 1];
      const curr = sequence[i];

      if (!prev.coordinates || !curr.coordinates) {
        unmeasurablePairs++;
        continue;
      }

      const speed = speedKph(prev, curr);
      if (speed === null) {
        unmeasurablePairs++;
        continue;
      }

      if (speed < minKphThreshold) {
        toRemove.add(prev.name);
      }
    }
  }

  return { toRemove, unmeasurablePairs };
};

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

const getOutputPath = (inputRoot, outputRoot, folderPath, fileName) => {
  const srcPath = path.join(folderPath, fileName);
  const relativePath = path.relative(inputRoot, srcPath);
  return path.join(outputRoot, relativePath);
};

const moveMarkedPhotos = (folderPath, inputRoot, outputRoot, toRemove) => {
  let movedCount = 0;
  let skippedCount = 0;

  for (const fileName of toRemove) {
    const src = path.join(folderPath, fileName);
    if (!fs.existsSync(src)) {
      console.warn(`Skip (missing source): ${fileName}`);
      skippedCount++;
      continue;
    }

    const dest = getOutputPath(inputRoot, outputRoot, folderPath, fileName);
    if (fs.existsSync(dest)) {
      console.error(`Skip (destination exists): ${dest}`);
      skippedCount++;
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    movedCount++;
    console.log(`Moved: ${fileName}`);
  }

  return { movedCount, skippedCount };
};

const processFolder = (folderPath, inputRoot, outputRoot, minKphThreshold) => {
  return processFolderDetailed(folderPath, inputRoot, outputRoot, minKphThreshold).movedCount;
};

const processFolderDetailed = (folderPath, inputRoot, outputRoot, minKphThreshold) => {
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
    return { movedCount: 0, markedCount: 0, skippedCount: 0 };
  }

  const { sequences, timeGapSplits } = splitIntoSequences(files);
  const { toRemove, unmeasurablePairs } = markPhotosToRemove(sequences, minKphThreshold);
  const { movedCount, skippedCount } = moveMarkedPhotos(
    folderPath,
    inputRoot,
    outputRoot,
    toRemove
  );

  console.log(`掃描 ${files.length} 張，連續序列 ${sequences.length} 段`);
  console.log(`時間間隔切分 ${timeGapSplits} 次，無法判定相鄰組 ${unmeasurablePairs} 組`);
  console.log(`標記 ${toRemove.size} 張，移動 ${movedCount} 張，跳過 ${skippedCount} 張`);
  console.log(`資料夾 ${folderPath} 完成。`);

  return { movedCount, markedCount: toRemove.size, skippedCount };
};

/**
 * Repeat a folder pass until no photos are marked, or no marked photo can move.
 * The latter protects callers from an infinite loop when destination conflicts occur.
 */
const processUntilStable = (processPass, log = console.log) => {
  let pass = 0;
  let totalMoved = 0;

  while (true) {
    pass++;
    log(`\n--- 第 ${pass} 輪 ---`);
    const { movedCount, markedCount, skippedCount } = processPass();
    totalMoved += movedCount;

    if (markedCount === 0) {
      log(`第 ${pass} 輪未標記圖片，已穩定。`);
      return { totalMoved, passes: pass, stable: true };
    }

    if (movedCount === 0) {
      log(`第 ${pass} 輪標記 ${markedCount} 張但未移動任何圖片（跳過 ${skippedCount} 張），停止以避免無限重跑。`);
      return { totalMoved, passes: pass, stable: false };
    }
  }
};

const runCli = () => {
  if (process.argv.includes('--version')) {
    console.log(`checkimg-speed-dupe version: ${packageJson.version}`);
    process.exit(0);
  }

  const args = process.argv.slice(2);
  const untilStable = args.includes('--until-stable');
  const positionalArgs = args.filter(arg => arg !== '--until-stable');

  if (positionalArgs.length !== 3) {
    console.error('Usage: node checkimg_speed_dupe.js <inputFolder> <outputFolder> <minKph> [--until-stable]');
    process.exit(1);
  }

  const inputFolder = path.resolve(positionalArgs[0]);
  const outputFolder = path.resolve(positionalArgs[1]);
  const minKph = parseFloat(positionalArgs[2]);

  if (!Number.isFinite(minKph) || minKph < 0) {
    console.error('minKph must be a non-negative number');
    process.exit(1);
  }

  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
  }

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
    if (!untilStable) {
      totalMoved += processFolder(folderPath, inputFolder, outputFolder, minKph);
      return;
    }

    const result = processUntilStable(() => processFolderDetailed(
      folderPath,
      inputFolder,
      outputFolder,
      minKph
    ));
    totalMoved += result.totalMoved;
    if (!result.stable) {
      console.warn(`資料夾 ${folderPath} 尚未穩定，請處理輸出位置衝突後再執行。`);
    }
  });

  console.log(`\n全部完成。共移動 ${totalMoved} 張圖片到 ${outputFolder}`);
};

if (require.main === module) {
  runCli();
}

module.exports = {
  SPLIT_TIME_SEC,
  splitIntoSequences,
  markPhotosToRemove,
  speedKph,
  distanceKm,
  processFolder,
  processUntilStable,
};
