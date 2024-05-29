const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

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
  const maxWorkers = 7;
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
  const Jimp = require('jimp');

  const processImagePair = async (currentFile, previousFile) => {
    const currentFilePath = path.join(inputFolder, currentFile);
    const previousFilePath = path.join(inputFolder, previousFile);

    try {
      const currentImage = await Jimp.read(currentFilePath);
      const previousImage = await Jimp.read(previousFilePath);

      // 比較前後兩張圖片的差異
      const diff = Jimp.diff(previousImage, currentImage);
      const distance = Jimp.distance(previousImage, currentImage);

      // 顯示正在處理的圖片名稱、diff 和 distance
      const logMessage = `Processing ${currentFile}, diff: ${(diff.percent * 100).toFixed(2)}%, distance: ${distance.toFixed(4)}`;
      parentPort.postMessage(logMessage);

      // 如果差異很小，表示圖片幾乎沒有變化，認為車輛停止
      if (diff.percent < 0.05 && distance < 0.016) { // 可以根據實際情況調整
        const outputFilePath = path.join(outputFolder, currentFile);
        fs.renameSync(currentFilePath, outputFilePath); // 使用 renameSync 來搬移文件
        parentPort.postMessage(`Moved: ${currentFile}`);
      }
    } catch (err) {
      parentPort.postMessage(`Error processing file ${currentFile}: ${err}`);
    }
  };

  processImagePair(currentFile, previousFile);
}