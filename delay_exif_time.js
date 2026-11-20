#!/usr/bin/env node

const path = require('node:path');
const {
  collectJpegs,
  ensureNewOutput,
  formatCaptureTime,
  formatDecimal,
  formatExifTime,
  parseExifTime,
  readPhotoTimes,
  writePhotoOutput,
} = require('./exif_capture_time');

const usage = '用法：node delay_exif_time.js <timecriteriaMin> <timecriteriaMax> <delaysec> <inputFolder> <outfolder>\n' +
  'delaysec 可輸入正負整數或小數，例如 +0.2 或 -0.2。';

function parseInteger(value, name) {
  const number = Number(value);
  if (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new Error(`${name} 必須是整數`);
  }
  return number;
}

function parseDelay(value) {
  const match = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(value);
  if (!match || (!match[2] && !match[3])) {
    throw new Error('delaysec 必須是整數或小數，例如 +0.2 或 -0.2');
  }
  const [, sign, whole, fraction = ''] = match;
  const magnitude = BigInt(whole + fraction);
  const precision = fraction.length;
  return { units: sign === '-' ? -magnitude : magnitude, precision, scale: 10n ** BigInt(precision) };
}

function adjustCaptureTime({ file, original, seconds }, offset, delay) {
  let adjustedSeconds = BigInt(seconds) + offset / delay.scale;
  let { subseconds } = original;
  const remainder = offset % delay.scale;
  if (remainder !== 0n) {
    const fraction = subseconds.trim();
    if (!/^\d*$/.test(fraction)) {
      throw new Error(`${file} 的 EXIF SubSecTimeOriginal 格式錯誤：${JSON.stringify(subseconds)}`);
    }
    const precision = Math.max(delay.precision, fraction.length);
    const scale = 10n ** BigInt(precision);
    const units = BigInt(fraction.padEnd(precision, '0')) + remainder * (scale / delay.scale);
    // BigInt division truncates toward zero, so a negative fraction borrows one second.
    const carry = units < 0n ? -1n : units / scale;
    adjustedSeconds += carry;
    subseconds = (units - carry * scale).toString().padStart(precision, '0');
  }
  return { dateTime: formatExifTime(Number(adjustedSeconds)), subseconds };
}

function logPhoto({ file, original, gap, offset, adjusted }, decision, delay) {
  console.log([
    JSON.stringify(file.slice(2)),
    formatCaptureTime(original),
    gap ?? '—',
    decision,
    offset === undefined ? '—' : formatDecimal(offset, delay),
    formatCaptureTime(adjusted),
  ].join('\t'));
}

function buildPlan(files, times, min, max, delay) {
  console.log(`依原始 EXIF 拍攝時間排序並計算 ${files.length} 張`);
  console.log('照片\t原始 EXIF 時間\t原始間隔（秒）\t判定\t累計偏移（秒）\t預計輸出時間');
  const photos = files.map((file) => {
    const original = times.get(file);
    const seconds = parseExifTime(original?.dateTime);
    if (seconds === null) {
      logPhoto({ file, original }, '缺少有效時間', delay);
      throw new Error(`${file} 缺少有效的 JPEG EXIF DateTimeOriginal`);
    }
    return { file, original, seconds };
  });
  photos.sort((a, b) => a.seconds - b.seconds);

  let previous = null;
  let offset = 0n;
  return photos.map((capture) => {
    const { file, original, seconds } = capture;
    const gap = previous === null ? null : seconds - previous;
    const triggered = gap !== null && gap >= min && gap <= max;
    if (triggered) offset += delay.units;

    const adjusted = adjustCaptureTime(capture, offset, delay);
    const photo = { file, original, gap, triggered, offset, adjusted };
    if (adjusted.dateTime === null) {
      logPhoto(photo, '超出 EXIF 日期範圍', delay);
      throw new Error(`${file} 的修正結果超出 EXIF 日期範圍`);
    }
    logPhoto(photo, previous === null ? '第一張' : triggered ? '觸發' : '未觸發', delay);
    previous = seconds;
    return photo;
  });
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
  const delay = parseDelay(rawDelay);
  if (min < 0 || max < min) throw new Error('時間區間必須符合 0 ≤ timecriteriaMin ≤ timecriteriaMax');

  const input = path.resolve(inputFolder);
  const output = path.resolve(outfolder);
  ensureNewOutput(output);
  const files = collectJpegs(input);

  console.log(`輸入目錄：${input}`);
  console.log(`輸出目錄：${output}`);
  console.log(`共 ${files.length} 張，原始間隔 ${min} 至 ${max} 秒（含）時，每次偏移 ${formatDecimal(delay.units, delay)} 秒`);

  const plan = buildPlan(files, readPhotoTimes(input, files, '已讀取原始 EXIF'), min, max, delay);
  const changes = plan.filter(({ offset }) => offset !== 0n);
  const unchanged = plan.filter(({ offset }) => offset === 0n);

  writePhotoOutput(input, output, changes, unchanged, '.delay-exif-time-');

  const triggers = plan.filter(({ triggered }) => triggered).length;
  console.log(`共輸出 ${plan.length} 張，觸發 ${triggers} 次，修正 ${changes.length} 張。輸出目錄：${output}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
