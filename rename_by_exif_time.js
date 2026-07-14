#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const piexif = require('piexifjs');
const packageJson = require('./package.json');

const OFFSET_TIME_ORIGINAL = 0x9011;
const OFFSET_TIME = 0x9010;
const OFFSET_TIME_DIGITIZED = 0x9012;
const EXIF_IFD_POINTER = 0x8769;
const TIFF_TYPE_ASCII = 2;

const usage = () => {
  console.log(`Usage:
  node rename_by_exif_time.js <inputFolder> [options]

Options:
  --apply                 Actually rename files. Default is dry-run.
  --no-recursive          Only process JPG files directly under inputFolder.
  --timezone <±HH:MM>     Fallback timezone when EXIF OffsetTimeOriginal is missing. Default: +08:00.
  --prefix <text>         Prefix before timestamp. Default: empty.
  --suffix <text>         Suffix after timestamp, before collision counter. Default: empty.
  --lower-ext             Force lowercase file extension. Default: preserve original extension case.
  --version               Print version.

Output filename:
  <prefix>YYYY-MM-DDTHH-mm-ss±HHMM<suffix>.jpg

Collision handling:
  Existing or duplicate names get _001, _002, ... appended before the extension.
`);
};

const parseTimezoneOffset = (value) => {
  if (!value || typeof value !== 'string') return null;
  const match = value.trim().match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match) return null;

  const sign = match[1] === '+' ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);
  if (hours > 14 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
};

const formatOffset = (offsetMinutes, colon = false) => {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return colon ? `${sign}${h}:${m}` : `${sign}${h}${m}`;
};

const readOffsetTimeFromJpeg = (jpegBuffer) => {
  if (!Buffer.isBuffer(jpegBuffer) || jpegBuffer.length < 4) return null;

  let markerOffset = 2;
  while (markerOffset + 4 <= jpegBuffer.length) {
    if (jpegBuffer[markerOffset] !== 0xff) return null;

    const marker = jpegBuffer[markerOffset + 1];
    if (marker === 0xda || marker === 0xd9) return null;

    const segmentLength = jpegBuffer.readUInt16BE(markerOffset + 2);
    const segmentStart = markerOffset + 4;
    const segmentEnd = markerOffset + 2 + segmentLength;
    if (segmentLength < 2 || segmentEnd > jpegBuffer.length) return null;

    if (
      marker === 0xe1 &&
      segmentStart + 6 <= segmentEnd &&
      jpegBuffer.toString('ascii', segmentStart, segmentStart + 6) === 'Exif\0\0'
    ) {
      return readOffsetTimeFromTiff(jpegBuffer, segmentStart + 6, segmentEnd);
    }

    markerOffset = segmentEnd;
  }
  return null;
};

const readOffsetTimeFromTiff = (buffer, tiffStart, tiffEnd) => {
  if (tiffStart + 8 > tiffEnd) return null;

  const byteOrder = buffer.toString('ascii', tiffStart, tiffStart + 2);
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') return null;

  const readUInt16 = (offset) => {
    if (offset < tiffStart || offset + 2 > tiffEnd) return null;
    return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  };
  const readUInt32 = (offset) => {
    if (offset < tiffStart || offset + 4 > tiffEnd) return null;
    return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  };
  const relativeOffset = (value) => {
    if (value === null) return null;
    const offset = tiffStart + value;
    return offset >= tiffStart && offset < tiffEnd ? offset : null;
  };
  const findEntry = (ifdOffset, targetTag) => {
    const count = readUInt16(ifdOffset);
    if (count === null || ifdOffset + 2 + count * 12 + 4 > tiffEnd) return null;

    for (let i = 0; i < count; i += 1) {
      const entryOffset = ifdOffset + 2 + i * 12;
      if (readUInt16(entryOffset) === targetTag) return entryOffset;
    }
    return null;
  };
  const readAsciiEntry = (entryOffset) => {
    if (entryOffset === null) return null;
    const type = readUInt16(entryOffset + 2);
    const count = readUInt32(entryOffset + 4);
    if (type !== TIFF_TYPE_ASCII || count === null || count <= 0) return null;

    const valueOffset = count <= 4 ? entryOffset + 8 : relativeOffset(readUInt32(entryOffset + 8));
    if (valueOffset === null || valueOffset + count > tiffEnd) return null;
    return buffer
      .toString('ascii', valueOffset, valueOffset + count)
      .replace(/\0+$/, '')
      .trim();
  };

  const firstIfdOffset = relativeOffset(readUInt32(tiffStart + 4));
  if (firstIfdOffset === null) return null;

  const exifPointer = findEntry(firstIfdOffset, EXIF_IFD_POINTER);
  const exifIfdOffset = exifPointer === null ? null : relativeOffset(readUInt32(exifPointer + 8));
  if (exifIfdOffset === null) return null;

  return (
    readAsciiEntry(findEntry(exifIfdOffset, OFFSET_TIME_ORIGINAL)) ||
    readAsciiEntry(findEntry(exifIfdOffset, OFFSET_TIME)) ||
    readAsciiEntry(findEntry(exifIfdOffset, OFFSET_TIME_DIGITIZED))
  );
};

const parseExifDateTime = (value) => {
  if (!value || typeof value !== 'string') return null;
  const match = value
    .trim()
    .match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) return null;

  const ms = match[7] ? parseInt(match[7].padEnd(3, '0').slice(0, 3), 10) : 0;
  return {
    year: parseInt(match[1], 10),
    month: parseInt(match[2], 10),
    day: parseInt(match[3], 10),
    hour: parseInt(match[4], 10),
    minute: parseInt(match[5], 10),
    second: parseInt(match[6], 10),
    ms: Number.isFinite(ms) ? ms : 0,
  };
};

const formatTimestamp = (parts, offsetMinutes) => {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T` +
    `${pad(parts.hour)}-${pad(parts.minute)}-${pad(parts.second)}` +
    formatOffset(offsetMinutes)
  );
};

const collectJpegs = (root, recursive) => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(fullPath);
        continue;
      }
      if (entry.isFile() && /\.jpe?g$/i.test(entry.name)) {
        files.push(fullPath);
      }
    }
  };
  walk(root);
  return files.sort((a, b) => a.localeCompare(b));
};

const readCaptureInfo = (filePath, fallbackOffsetMinutes) => {
  const buffer = fs.readFileSync(filePath);
  let exifData;
  try {
    exifData = piexif.load(buffer.toString('binary'));
  } catch (err) {
    return { error: `invalid_exif: ${err.message}` };
  }

  const exif = exifData.Exif || {};
  const image = exifData['0th'] || {};
  const rawDateTime =
    exif[piexif.ExifIFD.DateTimeOriginal] ||
    exif[piexif.ExifIFD.DateTimeDigitized] ||
    image[piexif.ImageIFD.DateTime];
  const parts = parseExifDateTime(rawDateTime);
  if (!parts) {
    return { error: 'no_exif_datetime' };
  }

  const rawOffset = readOffsetTimeFromJpeg(buffer);
  const offsetMinutes = parseTimezoneOffset(rawOffset) ?? fallbackOffsetMinutes;
  return {
    parts,
    offsetMinutes,
    rawDateTime,
    offsetSource: rawOffset ? 'exif' : 'fallback',
  };
};

const uniqueTargetPath = (desiredPath, sourcePath, plannedTargets) => {
  const dir = path.dirname(desiredPath);
  const ext = path.extname(desiredPath);
  const base = path.basename(desiredPath, ext);
  let target = desiredPath;
  let n = 0;

  while (
    plannedTargets.has(target) ||
    (fs.existsSync(target) && path.resolve(target) !== path.resolve(sourcePath))
  ) {
    n += 1;
    target = path.join(dir, `${base}_${String(n).padStart(3, '0')}${ext}`);
  }
  plannedTargets.add(target);
  return target;
};

const parseArgs = (argv) => {
  const opts = {
    inputFolder: null,
    apply: false,
    recursive: true,
    timezone: '+08:00',
    prefix: '',
    suffix: '',
    lowerExt: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--version') {
      opts.version = true;
    } else if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--no-recursive') {
      opts.recursive = false;
    } else if (arg === '--timezone') {
      opts.timezone = argv[++i];
    } else if (arg === '--prefix') {
      opts.prefix = argv[++i] || '';
    } else if (arg === '--suffix') {
      opts.suffix = argv[++i] || '';
    } else if (arg === '--lower-ext') {
      opts.lowerExt = true;
    } else if (!opts.inputFolder) {
      opts.inputFolder = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
};

const main = () => {
  const opts = parseArgs(process.argv);
  if (opts.version) {
    console.log(`rename-by-exif-time version: ${packageJson.version}`);
    return;
  }
  if (opts.help || !opts.inputFolder) {
    usage();
    process.exit(opts.help ? 0 : 1);
  }

  const fallbackOffsetMinutes = parseTimezoneOffset(opts.timezone);
  if (fallbackOffsetMinutes === null) {
    throw new Error(`Invalid --timezone: ${opts.timezone}`);
  }

  const inputRoot = path.resolve(opts.inputFolder);
  if (!fs.existsSync(inputRoot) || !fs.statSync(inputRoot).isDirectory()) {
    throw new Error(`Input folder does not exist or is not a directory: ${opts.inputFolder}`);
  }

  const files = collectJpegs(inputRoot, opts.recursive);
  const plannedTargets = new Set();
  let renamed = 0;
  let unchanged = 0;
  let skipped = 0;

  console.log(`${opts.apply ? 'apply' : 'dry-run'}\tfiles=${files.length}\trecursive=${opts.recursive}`);

  for (const filePath of files) {
    const rel = path.relative(inputRoot, filePath);
    const info = readCaptureInfo(filePath, fallbackOffsetMinutes);
    if (info.error) {
      skipped += 1;
      console.log(`skip\t${rel}\t${info.error}`);
      continue;
    }

    const ext = opts.lowerExt ? path.extname(filePath).toLowerCase() : path.extname(filePath);
    const timestamp = formatTimestamp(info.parts, info.offsetMinutes);
    const desiredName = `${opts.prefix}${timestamp}${opts.suffix}${ext}`;
    const desiredPath = path.join(path.dirname(filePath), desiredName);
    const targetPath = uniqueTargetPath(desiredPath, filePath, plannedTargets);
    const targetRel = path.relative(inputRoot, targetPath);

    if (path.resolve(filePath) === path.resolve(targetPath)) {
      unchanged += 1;
      console.log(`ok\t${rel}`);
      continue;
    }

    renamed += 1;
    console.log(
      `${opts.apply ? 'rename' : 'would-rename'}\t${rel}\t=>\t${targetRel}\t` +
        `time=${info.rawDateTime}${formatOffset(info.offsetMinutes, true)}\toffset=${info.offsetSource}`
    );
    if (opts.apply) {
      fs.renameSync(filePath, targetPath);
    }
  }

  console.log(`summary\trenamed=${renamed}\tunchanged=${unchanged}\tskipped=${skipped}`);
  if (!opts.apply) {
    console.log('dry-run only; add --apply to rename files.');
  }
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

