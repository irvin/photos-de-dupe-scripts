#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BATCH_SIZE = 200;
const DATE_TAG = 'ExifIFD:DateTimeOriginal';
const SUBSEC_TAG = 'ExifIFD:SubSecTimeOriginal';

const usage = '用法：node calibrate_exif_time.js <anchor1File> <anchor1CorrectTime> ' +
  '<anchor2File> <anchor2CorrectTime> <inputFolder> <outfolder> [--dry-run]\n' +
  '正確時間格式為 YYYY-MM-DDTHH:mm:ss[.小數秒]，使用與 EXIF 相同的時區。';

function formatDecimal(units, { scale, precision }) {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const fraction = (magnitude % scale).toString().padStart(precision, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${magnitude / scale}${fraction ? `.${fraction}` : ''}`;
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
    const json = runExifTool(folder, [
      '-j', '-api', 'StructFormat=JSONQ', '-File:FileType', `-${DATE_TAG}`, `-${SUBSEC_TAG}`, ...batch,
    ]);
    for (const { SourceFile, FileType, DateTimeOriginal, SubSecTimeOriginal } of JSON.parse(json)) {
      if (FileType === 'JPEG') {
        times.set(SourceFile, {
          dateTime: DateTimeOriginal,
          subseconds: String(SubSecTimeOriginal ?? ''),
        });
      }
    }
    console.log(`${progressLabel} ${i + batch.length}/${files.length} 張`);
  }
  return times;
}

function formatCaptureTime(time) {
  if (!time?.dateTime) return '—';
  return time.subseconds ? `${time.dateTime}.${time.subseconds}` : time.dateTime;
}

function writeAdjustedCopies(input, staging, changes) {
  if (changes.length === 0) return;
  const csvName = '.exif-capture-time.csv';
  const csvPath = path.join(staging, csvName);
  const sources = changes.map(({ file }) => path.join(input, file));
  const rows = changes.map(({ original, adjusted }, index) => {
    const source = sources[index].replaceAll('"', '""');
    // An empty CSV value leaves the source tag untouched.
    const subseconds = adjusted.subseconds === original.subseconds ? '' : adjusted.subseconds;
    return `"${source}",${adjusted.dateTime},${subseconds}`;
  });
  fs.writeFileSync(csvPath, [`SourceFile,${DATE_TAG},${SUBSEC_TAG}`, ...rows, ''].join('\n'), { flag: 'wx' });

  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const batch = sources.slice(i, i + BATCH_SIZE);
    // Keep the output format relative so ExifTool doesn't interpret percent signs in the staging path.
    runExifTool(staging, [`-csv=${csvName}`, '-o', './', ...batch]);
    console.log(`已輸出修正 EXIF 的副本 ${i + batch.length}/${sources.length} 張`);
  }
  fs.unlinkSync(csvPath);

  const files = changes.map(({ file }) => file);
  const writtenTimes = readPhotoTimes(staging, files, '已重新讀取寫入結果');
  for (const { file, adjusted } of changes) {
    const written = writtenTimes.get(file);
    if (written?.dateTime !== adjusted.dateTime || written?.subseconds !== adjusted.subseconds) {
      throw new Error(`${file} 寫入後的 EXIF 時間驗證失敗`);
    }
  }
}

function ensureNewOutput(output) {
  if (fs.lstatSync(output, { throwIfNoEntry: false })) {
    throw new Error(`輸出路徑已存在：${output}`);
  }
}

function collectJpegs(input) {
  const files = fs.readdirSync(input, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.jpe?g$/i.test(entry.name))
    .map((entry) => `./${entry.name}`);
  if (files.length === 0) throw new Error(`找不到 JPEG 照片：${input}`);
  return files;
}

function writePhotoOutput(input, output, changes, unchanged) {
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.calibrate-exif-time-'));
  let published = false;
  try {
    writeAdjustedCopies(input, staging, changes);
    for (const [index, { file }] of unchanged.entries()) {
      fs.copyFileSync(path.join(input, file), path.join(staging, file), fs.constants.COPYFILE_EXCL);
      const copied = index + 1;
      if (copied % BATCH_SIZE === 0 || copied === unchanged.length) {
        console.log(`已複製無需修正的照片 ${copied}/${unchanged.length} 張`);
      }
    }
    ensureNewOutput(output);
    fs.renameSync(staging, output);
    published = true;
  } finally {
    if (!published) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function parseCorrectTime(value, label) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error(`${label} 必須是 YYYY-MM-DDTHH:mm:ss[.小數秒]：${value}`);
  const [, date, time, subseconds = ''] = match;
  const dateTime = `${date.replaceAll('-', ':')} ${time}`;
  const seconds = parseExifTime(dateTime);
  if (seconds === null) throw new Error(`${label} 的日期或時間無效：${value}`);
  return { dateTime, subseconds, seconds };
}

function timeUnits(seconds, subseconds, { scale, precision }) {
  return BigInt(seconds) * scale + BigInt(subseconds.padEnd(precision, '0'));
}

function roundDivision(numerator, denominator) {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (magnitude + denominator / 2n) / denominator;
  return numerator < 0n ? -rounded : rounded;
}

function timestampFromUnits(units, { scale, precision }) {
  const fraction = ((units % scale) + scale) % scale;
  return {
    dateTime: formatExifTime(Number((units - fraction) / scale)),
    subseconds: fraction.toString().padStart(precision, '0'),
  };
}

function buildPlan(files, times, anchorInputs) {
  const photos = files.map((file) => {
    const original = times.get(file);
    const seconds = parseExifTime(original?.dateTime);
    if (seconds === null) throw new Error(`${file} 缺少有效的 JPEG EXIF DateTimeOriginal`);
    const fraction = original.subseconds.trim();
    if (!/^\d*$/.test(fraction)) {
      throw new Error(`${file} 的 EXIF SubSecTimeOriginal 格式錯誤：${JSON.stringify(original.subseconds)}`);
    }
    return { file, original, seconds, fraction };
  });
  const precision = Math.max(
    3,
    anchorInputs[0].correct.subseconds.length,
    anchorInputs[1].correct.subseconds.length,
    photos.reduce((longest, photo) => Math.max(longest, photo.fraction.length), 0)
  );
  const clock = { precision, scale: 10n ** BigInt(precision) };
  const captures = photos.map(({ file, original, seconds, fraction }) => ({
    file, original, measured: timeUnits(seconds, fraction, clock),
  })).sort((a, b) => Number(a.measured - b.measured));
  const anchors = anchorInputs.map(({ file, correct }) => ({
    ...captures.find((photo) => photo.file === file),
    correct,
    target: timeUnits(correct.seconds, correct.subseconds, clock),
  })).sort((a, b) => Number(a.measured - b.measured));
  const [first, second] = anchors;
  const measuredSpan = second.measured - first.measured;
  const correctSpan = second.target - first.target;
  if (measuredSpan === 0n) throw new Error('兩張校準照片的原始 EXIF 拍攝時間必須不同');
  if (correctSpan <= 0n) throw new Error('兩張照片的正確時間必須依原始 EXIF 時間的先後順序遞增');

  for (const [index, anchor] of anchors.entries()) {
    console.log(`校準點 ${index + 1}：${JSON.stringify(anchor.file.slice(2))}  ` +
      `${formatCaptureTime(anchor.original)} → ${formatCaptureTime(anchor.correct)}`);
  }
  const ratioDisplay = { precision: 9, scale: 1_000_000_000n };
  const ratio = roundDivision(correctSpan * ratioDisplay.scale, measuredSpan);
  console.log(`原始時間差 ${formatDecimal(measuredSpan, clock)} 秒，` +
    `正確時間差 ${formatDecimal(correctSpan, clock)} 秒，校準倍率約 ${formatDecimal(ratio, ratioDisplay)}`);
  console.log('照片\t原始 EXIF 時間\t修正量（秒）\t預計輸出時間');

  let before = 0;
  let after = 0;
  const plan = captures.map(({ file, original, measured }) => {
    if (measured < first.measured) before++;
    if (measured > second.measured) after++;
    // Compute the exact affine transform, then round once to the output precision.
    const target = roundDivision(first.target * measuredSpan + (measured - first.measured) * correctSpan, measuredSpan);
    const offset = target - measured;
    const adjusted = offset === 0n ? original : timestampFromUnits(target, clock);
    if (adjusted.dateTime === null) throw new Error(`${file} 的校準結果超出 EXIF 日期範圍`);
    console.log([
      JSON.stringify(file.slice(2)),
      formatCaptureTime(original),
      formatDecimal(offset, clock),
      formatCaptureTime(adjusted),
    ].join('\t'));
    return { file, original, offset, adjusted };
  });

  console.log(`校準區間外 ${before + after} 張，早於第一個校準點 ${before} 張，晚於第二個校準點 ${after} 張`);
  for (const [label, photo] of [['最早', plan[0]], ['最晚', plan.at(-1)]]) {
    console.log(`${label}照片 ${JSON.stringify(photo.file.slice(2))}，修正量 ${formatDecimal(photo.offset, clock)} 秒`);
  }
  return plan;
}

function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage);
    return;
  }
  const dryRun = args.at(-1) === '--dry-run';
  const positional = dryRun ? args.slice(0, -1) : args;
  if (positional.length !== 6) throw new Error(usage);
  const [firstName, firstTime, secondName, secondTime, inputFolder, outfolder] = positional;
  if (firstName === secondName) throw new Error('校準需要兩張不同的照片');
  const anchorInputs = [
    { file: `./${firstName}`, correct: parseCorrectTime(firstTime, '第一個校準時間') },
    { file: `./${secondName}`, correct: parseCorrectTime(secondTime, '第二個校準時間') },
  ];
  const input = path.resolve(inputFolder);
  const output = path.resolve(outfolder);
  if (!dryRun) ensureNewOutput(output);
  const files = collectJpegs(input);
  for (const { file } of anchorInputs) {
    if (!files.includes(file)) throw new Error(`在輸入目錄找不到校準照片：${file.slice(2)}`);
  }

  console.log(`輸入目錄：${input}`);
  console.log(`輸出目錄：${output}`);
  if (dryRun) console.log('預覽模式');
  const plan = buildPlan(files, readPhotoTimes(input, files, '已讀取原始 EXIF'), anchorInputs);
  const changes = plan.filter(({ offset }) => offset !== 0n);
  if (dryRun) {
    console.log(`預覽完成，共 ${plan.length} 張，預計修正 ${changes.length} 張`);
    return;
  }
  const unchanged = plan.filter(({ offset }) => offset === 0n);
  writePhotoOutput(input, output, changes, unchanged);
  console.log(`共輸出 ${plan.length} 張，修正 ${changes.length} 張。輸出目錄：${output}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
