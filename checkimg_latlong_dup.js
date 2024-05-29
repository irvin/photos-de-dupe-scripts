#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const exifParser = require('exif-parser');

if (isMainThread) {
  // 檢查命令行參數
  if (process.argv.length !== 4) {
    console.error('Usage: node script.js <inputFolder> <outputFolder>');
    process.exit(1);
  }

  const inputFolder = process.argv[2];
  const outputFolder = process.argv[3];

  // 確保輸出資料夾存在
  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder);
  }

  // 讀取所有圖片檔案
  const files = fs.readdirSync(inputFolder).filter(file => file.endsWith('.jpg'));

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
        inputFolder,
        outputFolder,
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
        console.log('All images processed.');
      } else {
        startWorker(); // 啟動下一個工作者
      }
    });
  };

  // 初始啟動工作者
  for (let i = 0; i < maxWorkers && index < files.length; i++) {
    startWorker();
  }
} else {
  // 工作者執行緒程式
  const { currentFile, previousFile, inputFolder, outputFolder } = workerData;

  const getGpsCoordinates = (filePath) => {
    try {
      const buffer = fs.readFileSync(filePath);
      const parser = exifParser.create(buffer);
      const result = parser.parse();
      const gps = result.tags.GPSLatitude && result.tags.GPSLongitude
        ? { lat: result.tags.GPSLatitude, lon: result.tags.GPSLongitude }
        : null;
      return gps;
    } catch (err) {
      parentPort.postMessage(`Error reading EXIF data from file ${filePath}: ${err}`);
      return null;
    }
  };

  const processImagePair = (currentFile, previousFile) => {
    const currentFilePath = path.join(inputFolder, currentFile);
    const previousFilePath = path.join(inputFolder, previousFile);

    const currentGps = getGpsCoordinates(currentFilePath);
    const previousGps = getGpsCoordinates(previousFilePath);

    if (currentGps && previousGps) {
      const logMessage = `Processing ${currentFile}, current: (${currentGps.lat}, ${currentGps.lon}), previous: (${previousGps.lat}, ${previousGps.lon})`;
      parentPort.postMessage(logMessage);

      if (currentGps.lat === previousGps.lat && currentGps.lon === previousGps.lon) {
        const outputFilePath = path.join(outputFolder, currentFile);
        fs.renameSync(currentFilePath, outputFilePath); // 使用 renameSync 來搬移文件
        parentPort.postMessage(`Moved: ${currentFile}`);
      }
    } else {
      parentPort.postMessage(`Skipping ${currentFile} due to missing GPS data`);
    }
  };

  processImagePair(currentFile, previousFile);
}