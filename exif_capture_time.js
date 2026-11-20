const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BATCH_SIZE = 200;
const DATE_TAG = 'ExifIFD:DateTimeOriginal';
const SUBSEC_TAG = 'ExifIFD:SubSecTimeOriginal';

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

function writePhotoOutput(input, output, changes, unchanged, stagingPrefix) {
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, stagingPrefix));
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

module.exports = {
  collectJpegs,
  ensureNewOutput,
  formatCaptureTime,
  formatDecimal,
  formatExifTime,
  parseExifTime,
  readPhotoTimes,
  writePhotoOutput,
};
