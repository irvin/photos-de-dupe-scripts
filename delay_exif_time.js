#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BATCH_SIZE = 200;
const DATE_TAG = 'ExifIFD:DateTimeOriginal';
const usage = '用法：node delay_exif_time.js <timecriteriaMin> <timecriteriaMax> <delaysec> <inputFolder> <outfolder>';

function parseInteger(value, name) {
  const number = Number(value);
  if (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new Error(`${name} 必須是整數`);
  }
  return number;
}

function runExifTool(cwd, args) {
  try {
    return execFileSync('exiftool', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('找不到 exiftool，請先安裝 ExifTool');
    throw new Error(error.stderr?.trim() || error.message);
  }
}

function formatExifTime(seconds) {
  const date = new Date(seconds * 1000);
  const year = date.getUTCFullYear();
  if (!(year >= 1 && year <= 9999)) return null;
  return date.toISOString().slice(0, 19).replaceAll('-', ':').replace('T', ' ');
}

function parseExifTime(value) {
  if (typeof value !== 'string' || !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return null;
  }
  // Treat EXIF local calendar fields as UTC for arithmetic, without changing their timezone.
  const iso = `${value.slice(0, 10).replaceAll(':', '-')}T${value.slice(11)}Z`;
  const seconds = Date.parse(iso) / 1000;
  return formatExifTime(seconds) === value ? seconds : null;
}

function readPhotoTimes(folder, files, progressLabel) {
  const times = new Map();
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const json = runExifTool(folder, ['-j', '-File:FileType', `-${DATE_TAG}`, ...batch]);
    for (const { SourceFile, FileType, DateTimeOriginal } of JSON.parse(json)) {
      if (FileType === 'JPEG') times.set(SourceFile, DateTimeOriginal);
    }
    console.log(`${progressLabel} ${i + batch.length}/${files.length} 張`);
  }
  return times;
}

function logPhoto({ file, original, gap, offset, adjusted }, decision) {
  console.log([
    JSON.stringify(file.slice(2)),
    original ?? '—',
    gap ?? '—',
    decision,
    offset ?? '—',
    adjusted ?? '—',
  ].join('\t'));
}

function buildPlan(files, times, min, max, delay) {
  console.log(`依原始 EXIF 拍攝時間排序並計算 ${files.length} 張`);
  console.log('照片\t原始 EXIF 時間\t原始間隔（秒）\t判定\t累計偏移（秒）\t預計輸出時間');
  const photos = files.map((file) => {
    const original = times.get(file);
    const seconds = parseExifTime(original);
    if (seconds === null) {
      logPhoto({ file, original }, '缺少有效時間');
      throw new Error(`${file} 缺少有效的 JPEG EXIF DateTimeOriginal`);
    }
    return { file, original, seconds };
  });
  photos.sort((a, b) => a.seconds - b.seconds);

  let previous = null;
  let offset = 0;
  return photos.map(({ file, original, seconds }) => {
    const gap = previous === null ? null : seconds - previous;
    const triggered = gap !== null && gap >= min && gap <= max;
    if (triggered) offset += delay;

    const adjusted = formatExifTime(seconds + offset);
    const photo = { file, original, gap, triggered, offset, adjusted };
    if (adjusted === null) {
      logPhoto(photo, '超出 EXIF 日期範圍');
      throw new Error(`${file} 的修正結果超出 EXIF 日期範圍`);
    }
    logPhoto(photo, previous === null ? '第一張' : triggered ? '觸發' : '未觸發');
    previous = seconds;
    return photo;
  });
}

function writeAdjustedTimes(folder, changes) {
  if (changes.length === 0) return;
  const csvName = '.delay-exif-time.csv';
  const csvPath = path.join(folder, csvName);
  const rows = changes.map(({ file, adjusted }) => `"${file.replaceAll('"', '""')}",${adjusted}`);
  fs.writeFileSync(csvPath, [`SourceFile,${DATE_TAG}`, ...rows, ''].join('\n'), { flag: 'wx' });

  const files = changes.map(({ file }) => file);
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    runExifTool(folder, [`-csv=${csvName}`, '-overwrite_original', ...batch]);
    console.log(`已寫入副本 EXIF ${i + batch.length}/${files.length} 張`);
  }
  fs.unlinkSync(csvPath);

  const writtenTimes = readPhotoTimes(folder, files, '已重新讀取寫入結果');
  for (const { file, adjusted } of changes) {
    if (writtenTimes.get(file) !== adjusted) throw new Error(`${file} 寫入後的 EXIF 時間驗證失敗`);
  }
}

function main(args) {
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) {
    console.log(usage);
    return;
  }
  if (args.length !== 5) throw new Error(usage);

  const [rawMin, rawMax, rawDelay, inputFolder, outfolder] = args;
  const min = parseInteger(rawMin, 'timecriteriaMin');
  const max = parseInteger(rawMax, 'timecriteriaMax');
  const delay = parseInteger(rawDelay, 'delaysec');
  if (min < 0 || max < min) throw new Error('時間區間必須符合 0 ≤ timecriteriaMin ≤ timecriteriaMax');

  const input = path.resolve(inputFolder);
  const output = path.resolve(outfolder);
  if (fs.lstatSync(output, { throwIfNoEntry: false })) {
    throw new Error(`輸出路徑已存在：${output}`);
  }
  const files = fs.readdirSync(input, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.jpe?g$/i.test(entry.name))
    .map((entry) => `./${entry.name}`);
  if (files.length === 0) throw new Error(`找不到 JPEG 照片：${input}`);

  console.log(`輸入目錄：${input}`);
  console.log(`輸出目錄：${output}`);
  console.log(`共 ${files.length} 張，原始間隔 ${min} 至 ${max} 秒（含）時，每次偏移 ${delay} 秒`);

  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.delay-exif-time-'));
  let published = false;
  let plan;
  let changes;
  try {
    for (const [index, file] of files.entries()) {
      fs.copyFileSync(path.join(input, file), path.join(staging, file), fs.constants.COPYFILE_EXCL);
      const copied = index + 1;
      if (copied % BATCH_SIZE === 0 || copied === files.length) {
        console.log(`已複製 ${copied}/${files.length} 張到暫存目錄`);
      }
    }
    plan = buildPlan(files, readPhotoTimes(staging, files, '已讀取原始 EXIF'), min, max, delay);
    changes = plan.filter(({ offset }) => offset !== 0);
    writeAdjustedTimes(staging, changes);
    if (fs.lstatSync(output, { throwIfNoEntry: false })) {
      throw new Error(`輸出路徑已存在：${output}`);
    }
    fs.renameSync(staging, output);
    published = true;
  } finally {
    if (!published) fs.rmSync(staging, { recursive: true, force: true });
  }

  const triggers = plan.filter(({ triggered }) => triggered).length;
  console.log(`共輸出 ${plan.length} 張，觸發 ${triggers} 次，修正 ${changes.length} 張。輸出目錄：${output}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
