#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const piexif = require('piexifjs');
const packageJson = require('./package.json');

if (process.argv.includes('--version')) {
  console.log(`calcimg-dir version: ${packageJson.version}`);
  process.exit(0);
}

if (isMainThread) {
  // 檢查命令行參數
  if (process.argv.length < 3 || process.argv.length > 4) {
    console.error('Usage: node calcimg_dir.js <inputFolder> [bearingAdjustment]');
    console.error('  bearingAdjustment: 方向角度調整值（可選，預設為 0）');
    process.exit(1);
  }

  const inputFolder = process.argv[2];
  const bearingAdjustment = parseFloat(process.argv[3]) || 0;

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
          // 如果當前資料夾沒有 .jpg 檔案但有子資料夾，遞迴掃描子資料夾
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
      // EXIF 日期時間格式為 "YYYY:MM:DD HH:MM:SS"
      const [date, time] = exifDateTime.split(' ');
      const [year, month, day] = date.split(':');
      const [hour, minute, second] = time.split(':');

      return new Date(year, month - 1, day, hour, minute, second).getTime();
    } catch (err) {
      console.error(`Error parsing EXIF datetime: ${exifDateTime}`);
      return null;
    }
  };

  const getExifData = (filePath) => {
    try {
      const data = fs.readFileSync(filePath).toString('binary');
      const exifData = piexif.load(data);

      return {
        timestamp: getTimestamp(exifData),
        coordinates: getCoordinates(exifData)
      };
    } catch (err) {
      console.error(`Error reading EXIF: ${err}`);
      return { timestamp: null, coordinates: null };
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

  const processFolder = (folderPath, bearingAdjustment) => {
    console.log(`\n=== 處理資料夾: ${folderPath} ===`);

    // 讀取所有圖片檔案並按照 EXIF 時間排序
    let files = fs.readdirSync(folderPath)
      .filter(file => file.toLowerCase().endsWith('.jpg'))
      .map(file => {
        const filePath = path.join(folderPath, file);
        const exifInfo = getExifData(filePath);
        const fileTime = exifInfo.timestamp || fs.statSync(filePath).mtime.getTime();
        return {
          name: file,
          time: fileTime,
          coordinates: exifInfo.coordinates
        };
      })
      .sort((a, b) => a.time - b.time);

    if (files.length === 0) {
      console.log(`跳過空資料夾: ${folderPath}`);
      return;
    }

    if (files.length === 1) {
      console.log(`跳過只有一張圖片的資料夾: ${folderPath}`);
      return;
    }

    console.log(`找到 ${files.length} 張圖片，開始處理...`);

    // 設置同時運行的工作者數量
    const maxWorkers = 4;
    let currentWorkerCount = 0;
    let completedPairs = 0;
    let index = 1;

    const startWorker = () => {
      if (index >= files.length) {
        return;
      }

      const worker = new Worker(__filename, {
        workerData: {
          currentFile: files[index],
          previousFile: files[index - 1],
          inputFolder: folderPath,
          isFirstPair: index === 1,
          bearingAdjustment  // 傳遞角度調整值給 worker
        },
      });

      currentWorkerCount++;
      index++;

      worker.on('message', (message) => {
        console.log(message);
      });

      worker.on('error', (error) => {
        console.error(`Worker error: ${error}`);
      });

      worker.on('exit', (code) => {
        currentWorkerCount--;
        if (code !== 0) {
          console.error(`Worker stopped with exit code ${code}`);
        }
        completedPairs++;
        if (completedPairs === files.length - 1) {
          console.log(`資料夾 ${folderPath} 處理完成。`);
          // 清理記憶體：清空 files 陣列
          files = null;
        } else {
          startWorker();
        }
      });
    };

    // 初始啟動工作者
    for (let i = 0; i < maxWorkers && index < files.length; i++) {
      startWorker();
    }
  };

  // 掃描資料夾並處理
  const foldersToProcess = scanDirectory(inputFolder);

  if (foldersToProcess.length === 0) {
    console.log(`在 ${inputFolder} 中沒有找到包含 .jpg 檔案的資料夾。`);
    process.exit(1);
  }

  console.log(`找到 ${foldersToProcess.length} 個包含圖片的資料夾:`);
  foldersToProcess.forEach(folder => {
    console.log(`  - ${folder}`);
  });

  // 依序處理每個資料夾
  foldersToProcess.forEach(folderPath => {
    processFolder(folderPath, bearingAdjustment);
  });

  console.log(`\n所有資料夾處理完成！總共處理了 ${foldersToProcess.length} 個資料夾。`);
} else {
  // 工作者執行緒程式
  const { currentFile, previousFile, inputFolder, isFirstPair, bearingAdjustment } = workerData;

  const calculateBearing = (lat1, lon1, lat2, lon2) => {
    // 將經緯度轉換為弧度
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    // 計算方位角
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
            Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    let θ = Math.atan2(y, x);

    // 轉換為度數
    θ = θ * 180 / Math.PI;
    return (θ + 360) % 360; // 確保結果在 0-360 度之間
  };

  const writeDirectionToExif = (filePath, direction) => {
    try {
      const data = fs.readFileSync(filePath).toString('binary');
      const exifObj = piexif.load(data);

      exifObj['GPS'] = exifObj['GPS'] || {};
      exifObj['GPS'][piexif.GPSIFD.GPSImgDirection] = [direction * 100, 100]; // 轉換為有理數格式
      exifObj['GPS'][piexif.GPSIFD.GPSImgDirectionRef] = 'T'; // True direction

      const newData = piexif.insert(piexif.dump(exifObj), data);
      fs.writeFileSync(filePath, Buffer.from(newData, 'binary'));
      return true;
    } catch (err) {
      console.error(`Error writing EXIF: ${err}`);
      return false;
    }
  };

  const processImagePair = (currentFile, previousFile, isFirstPair) => {
    if (currentFile.coordinates && previousFile.coordinates) {
      let direction = calculateBearing(
        previousFile.coordinates.lat, previousFile.coordinates.lon,
        currentFile.coordinates.lat, currentFile.coordinates.lon
      );

      // 加入角度調整
      direction = (direction + bearingAdjustment + 360) % 360;

      const logMessage = `Processing ${currentFile.name}, direction: ${direction.toFixed(2)}° (adjusted by ${bearingAdjustment}°)`;
      parentPort.postMessage(logMessage);

      // 寫入當前照片的方向
      if (writeDirectionToExif(path.join(inputFolder, currentFile.name), direction)) {
        parentPort.postMessage(`Updated direction for: ${currentFile.name}`);
      }

      // 如果是第一組照片，也將相同的方向寫入第一張照片
      if (isFirstPair) {
        if (writeDirectionToExif(path.join(inputFolder, previousFile.name), direction)) {
          parentPort.postMessage(`Updated direction for first image: ${previousFile.name}`);
        }
      }
    } else {
      parentPort.postMessage(`Skipping ${currentFile.name} due to missing GPS data`);
    }
  };

  processImagePair(currentFile, previousFile, isFirstPair);
}