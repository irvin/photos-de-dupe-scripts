#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const piexif = require('piexifjs');
const packageJson = require('./package.json');

const OFFSET_TIME_ORIGINAL = 0x9011;
const DEFAULT_SPLIT_DISTANCE_M = 200;
const DEFAULT_SPLIT_TIME_SEC = 30;
const TIME_MISMATCH_WARN_MS = 2000;

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

const parseTimezoneOffset = (value) => {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const match = value.trim().match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match) {
    return null;
  }

  const sign = match[1] === '+' ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);

  if (hours > 14 || minutes > 59) {
    return null;
  }

  return sign * (hours * 60 + minutes);
};

const utcMsFromLocalParts = (year, month, day, hour, minute, second, offsetMinutes) => {
  return Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60 * 1000;
};

const parseExifDateTimeParts = (exifDateTime) => {
  if (!exifDateTime || typeof exifDateTime !== 'string') {
    return null;
  }

  const [datePart, timePart] = exifDateTime.split(' ');
  if (!datePart || !timePart) {
    return null;
  }

  const [year, month, day] = datePart.split(':').map(Number);
  const [hour, minute, second] = timePart.split(':').map(Number);

  if ([year, month, day, hour, minute, second].some((part) => Number.isNaN(part))) {
    return null;
  }

  return { year, month, day, hour, minute, second };
};

const parseGpsDateTimeUtc = (gps) => {
  if (!gps) {
    return null;
  }

  const dateStamp = gps[piexif.GPSIFD.GPSDateStamp];
  const timeStamp = gps[piexif.GPSIFD.GPSTimeStamp];

  if (!dateStamp || !Array.isArray(timeStamp) || timeStamp.length < 3) {
    return null;
  }

  const [year, month, day] = dateStamp.split(':').map(Number);
  const hour = timeStamp[0][0] / timeStamp[0][1];
  const minute = timeStamp[1][0] / timeStamp[1][1];
  const second = timeStamp[2][0] / timeStamp[2][1];

  if ([year, month, day, hour, minute, second].some((part) => Number.isNaN(part))) {
    return null;
  }

  return Date.UTC(year, month - 1, day, hour, minute, second);
};

const extractFilenameTimezone = (basename) => {
  const match = basename.match(/([+-]\d{2}:?\d{2})/);
  return match ? parseTimezoneOffset(match[1]) : null;
};

const formatOffsetMinutes = (minutes) => {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
};

const describeTimeSource = (timeInfo) => {
  switch (timeInfo.source) {
    case 'gps_datetime':
      return 'GPSDateStamp/GPSTimeStamp (UTC, no offset)';
    case 'datetime_offset_exif':
      return `DateTimeOriginal + EXIF OffsetTimeOriginal (${timeInfo.offsetLabel})`;
    case 'datetime_offset_filename':
      return `DateTimeOriginal + filename timezone (${timeInfo.offsetLabel})`;
    case 'datetime_offset_cli':
      return `DateTimeOriginal + --timezone (${timeInfo.offsetLabel})`;
    case 'filename':
      return `filename datetime (${timeInfo.offsetLabel})`;
    default:
      return timeInfo.source;
  }
};

const parseFilenameDateTime = (basename) => {
  const match = basename.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})([+-]\d{2}:?\d{2})_/
  );

  if (!match) {
    return null;
  }

  const offsetMinutes = parseTimezoneOffset(match[7]);
  if (offsetMinutes === null) {
    return null;
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);

  return {
    utcMs: utcMsFromLocalParts(year, month, day, hour, minute, second, offsetMinutes),
    source: 'filename',
    offsetMinutes,
    offsetLabel: formatOffsetMinutes(offsetMinutes),
  };
};

const resolveImageTime = (exifData, basename, cliTimezoneMinutes) => {
  const gps = exifData['GPS'] || {};
  const exif = exifData['Exif'] || {};
  const image = exifData['0th'] || {};

  const gpsUtcMs = parseGpsDateTimeUtc(gps);
  if (gpsUtcMs !== null) {
    return { utcMs: gpsUtcMs, source: 'gps_datetime', method: 1, offsetLabel: 'UTC' };
  }

  const dateTimeOriginal =
    exif[piexif.ExifIFD.DateTimeOriginal] || image[piexif.ImageIFD.DateTime];
  const dateParts = parseExifDateTimeParts(dateTimeOriginal);
  const filenameDateTime = parseFilenameDateTime(basename);

  const offsetFromExif = exif[OFFSET_TIME_ORIGINAL];
  const offsetFromExifMinutes = offsetFromExif ? parseTimezoneOffset(offsetFromExif) : null;
  if (dateParts && offsetFromExifMinutes !== null) {
    const utcMs = utcMsFromLocalParts(
      dateParts.year,
      dateParts.month,
      dateParts.day,
      dateParts.hour,
      dateParts.minute,
      dateParts.second,
      offsetFromExifMinutes
    );
    return {
      utcMs,
      source: 'datetime_offset_exif',
      method: 2,
      filenameDateTime,
      offsetMinutes: offsetFromExifMinutes,
      offsetLabel: formatOffsetMinutes(offsetFromExifMinutes),
    };
  }

  const offsetFromFilename = extractFilenameTimezone(basename);
  if (dateParts && offsetFromFilename !== null) {
    const utcMs = utcMsFromLocalParts(
      dateParts.year,
      dateParts.month,
      dateParts.day,
      dateParts.hour,
      dateParts.minute,
      dateParts.second,
      offsetFromFilename
    );
    return {
      utcMs,
      source: 'datetime_offset_filename',
      method: 3,
      filenameDateTime,
      offsetMinutes: offsetFromFilename,
      offsetLabel: formatOffsetMinutes(offsetFromFilename),
    };
  }

  if (dateParts && cliTimezoneMinutes !== null) {
    const utcMs = utcMsFromLocalParts(
      dateParts.year,
      dateParts.month,
      dateParts.day,
      dateParts.hour,
      dateParts.minute,
      dateParts.second,
      cliTimezoneMinutes
    );
    return {
      utcMs,
      source: 'datetime_offset_cli',
      method: 4,
      filenameDateTime,
      offsetMinutes: cliTimezoneMinutes,
      offsetLabel: formatOffsetMinutes(cliTimezoneMinutes),
    };
  }

  if (filenameDateTime) {
    return {
      utcMs: filenameDateTime.utcMs,
      source: 'filename',
      method: 5,
      offsetMinutes: filenameDateTime.offsetMinutes,
      offsetLabel: filenameDateTime.offsetLabel,
    };
  }

  return null;
};

const rationalToNumber = (value) => {
  if (Array.isArray(value) && value.length === 2) {
    return value[0] / value[1];
  }
  if (typeof value === 'number') {
    return value;
  }
  return null;
};

const getAltitudeMeters = (gps) => {
  if (!gps || gps[piexif.GPSIFD.GPSAltitude] === undefined) {
    return null;
  }

  const altitude = rationalToNumber(gps[piexif.GPSIFD.GPSAltitude]);
  if (altitude === null || Number.isNaN(altitude)) {
    return null;
  }

  const ref = gps[piexif.GPSIFD.GPSAltitudeRef];
  return ref === 1 ? -altitude : altitude;
};

const getCoordinates = (exifData) => {
  if (!exifData['GPS']) {
    return null;
  }

  const gps = exifData['GPS'];
  const lat = gps[piexif.GPSIFD.GPSLatitude];
  const lon = gps[piexif.GPSIFD.GPSLongitude];
  const latRef = gps[piexif.GPSIFD.GPSLatitudeRef];
  const lonRef = gps[piexif.GPSIFD.GPSLongitudeRef];

  if (!lat || !lon) {
    return null;
  }

  const latitude = convertDMSToDD(lat, latRef);
  const longitude = convertDMSToDD(lon, lonRef);

  if (
    latitude === null ||
    longitude === null ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  return {
    lat: latitude,
    lon: longitude,
    ele: getAltitudeMeters(gps),
  };
};

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const formatUtcIso = (utcMs) => {
  const date = new Date(utcMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
};

const collectJpgFiles = (inputFolder, recursive) => {
  const results = [];

  if (recursive) {
    const stack = ['.'];
    while (stack.length > 0) {
      const relDir = stack.pop();
      const absDir = path.join(inputFolder, relDir);
      const entries = fs.readdirSync(absDir, { withFileTypes: true });

      for (const entry of entries) {
        const relPath = relDir === '.' ? entry.name : path.join(relDir, entry.name);
        if (entry.isDirectory()) {
          stack.push(relPath);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jpg')) {
          results.push(relPath);
        }
      }
    }
  } else {
    const entries = fs.readdirSync(inputFolder, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.jpg')) {
        results.push(entry.name);
      }
    }
  }

  return results.sort();
};

const readImageRecord = (inputFolder, relPath, cliTimezoneMinutes) => {
  const absPath = path.join(inputFolder, relPath);
  const basename = path.basename(relPath);

  let exifData;
  try {
    const data = fs.readFileSync(absPath).toString('binary');
    exifData = piexif.load(data);
  } catch (err) {
    if (err instanceof SyntaxError || /Invalid/.test(String(err.message || err))) {
      return { relPath, basename, skipReason: 'invalid_exif', error: err.message };
    }
    return { relPath, basename, skipReason: 'read_error', error: err.message };
  }

  const timeInfo = resolveImageTime(exifData, basename, cliTimezoneMinutes);
  if (!timeInfo) {
    return { relPath, basename, skipReason: 'no_time' };
  }

  const coordinates = getCoordinates(exifData);
  const timeMismatchWarning =
    (timeInfo.method === 3 || timeInfo.method === 4) &&
    timeInfo.filenameDateTime &&
    Math.abs(timeInfo.utcMs - timeInfo.filenameDateTime.utcMs) > TIME_MISMATCH_WARN_MS
      ? basename
      : null;

  return {
    relPath,
    basename,
    utcMs: timeInfo.utcMs,
    coordinates,
    timeMismatchWarning,
    timeSource: timeInfo.source,
    timeSourceDescription: describeTimeSource(timeInfo),
    skipReason: coordinates ? null : 'no_gps',
  };
};

const buildSegments = (records, splitDistanceM, splitTimeSec) => {
  const timedRecords = records
    .filter((record) => record.utcMs !== undefined)
    .sort((a, b) => {
      if (a.utcMs !== b.utcMs) {
        return a.utcMs - b.utcMs;
      }
      return a.relPath.localeCompare(b.relPath);
    });

  const segments = [];
  let currentSegment = null;
  let lastValidGps = null;
  let noGpsGap = false;
  const splitEvents = [];
  let distanceSplitCount = 0;
  let timeSplitCount = 0;
  let maxSplitDistanceM = 0;
  let maxSplitTimeSec = 0;

  for (const record of timedRecords) {
    if (!record.coordinates) {
      noGpsGap = true;
      continue;
    }

    let startNewSegment = false;
    const reasons = [];
    let distanceM = 0;
    let timeSec = 0;

    if (lastValidGps === null) {
      startNewSegment = true;
    } else {
      if (noGpsGap) {
        startNewSegment = true;
        reasons.push('missing_gps_gap');
      }

      distanceM = distanceKm(
        lastValidGps.coordinates.lat,
        lastValidGps.coordinates.lon,
        record.coordinates.lat,
        record.coordinates.lon
      ) * 1000;
      timeSec = (record.utcMs - lastValidGps.utcMs) / 1000;

      if (distanceM > splitDistanceM) {
        startNewSegment = true;
        reasons.push(`distance ${distanceM.toFixed(1)} m > ${splitDistanceM} m`);
        distanceSplitCount += 1;
        maxSplitDistanceM = Math.max(maxSplitDistanceM, distanceM);
      }

      if (timeSec > splitTimeSec) {
        startNewSegment = true;
        reasons.push(`time ${Math.round(timeSec)} s > ${splitTimeSec} s`);
        timeSplitCount += 1;
        maxSplitTimeSec = Math.max(maxSplitTimeSec, timeSec);
      }
    }

    if (startNewSegment) {
      if (lastValidGps !== null) {
        splitEvents.push({
          reasons,
          from: lastValidGps.basename,
          to: record.basename,
          distanceM,
          timeSec,
        });
      }
      currentSegment = [];
      segments.push(currentSegment);
    }

    currentSegment.push(record);
    lastValidGps = record;
    noGpsGap = false;
  }

  return {
    segments,
    splitEvents,
    distanceSplitCount,
    timeSplitCount,
    maxSplitDistanceM,
    maxSplitTimeSec,
  };
};

const buildGpxXml = (segments) => {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<gpx version="1.0"',
    ' creator="jpg-to-gpx"',
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    ' xmlns="http://www.topografix.com/GPX/1/0"',
    ' xsi:schemaLocation="http://www.topografix.com/GPX/1/0 http://www.topografix.com/GPX/1/0/gpx.xsd">',
    ' <trk>',
  ];

  for (const segment of segments) {
    lines.push('   <trkseg>');
    for (const point of segment) {
      lines.push(
        `     <trkpt lat="${point.coordinates.lat}" lon="${point.coordinates.lon}">`
      );
      if (point.coordinates.ele !== null && point.coordinates.ele !== undefined) {
        lines.push(`       <ele>${point.coordinates.ele}</ele>`);
      }
      lines.push(`       <time>${formatUtcIso(point.utcMs)}</time>`);
      lines.push(`       <name>${escapeXml(point.basename)}</name>`);
      lines.push('     </trkpt>');
    }
    lines.push('   </trkseg>');
  }

  lines.push(' </trk>');
  lines.push('</gpx>');
  return `${lines.join('\n')}\n`;
};

const writeGpxAtomic = (outputGpx, content) => {
  const outputDir = path.dirname(outputGpx);
  fs.mkdirSync(outputDir, { recursive: true });

  const tempPath = path.join(outputDir, `.${path.basename(outputGpx)}.tmp`);
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, outputGpx);
};

const parseCliArgs = (argv) => {
  const options = {
    splitDistanceM: DEFAULT_SPLIT_DISTANCE_M,
    splitTimeSec: DEFAULT_SPLIT_TIME_SEC,
    timezone: null,
    recursive: false,
    force: false,
    help: false,
    version: false,
    positional: [],
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--version') {
      options.version = true;
      continue;
    }
    if (arg === '--recursive') {
      options.recursive = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--split-distance-m') {
      options.splitDistanceM = parseFloat(argv[++i]);
      continue;
    }
    if (arg.startsWith('--split-distance-m=')) {
      options.splitDistanceM = parseFloat(arg.split('=')[1]);
      continue;
    }
    if (arg === '--split-time-sec') {
      options.splitTimeSec = parseFloat(argv[++i]);
      continue;
    }
    if (arg.startsWith('--split-time-sec=')) {
      options.splitTimeSec = parseFloat(arg.split('=')[1]);
      continue;
    }
    if (arg === '--timezone') {
      options.timezone = argv[++i];
      continue;
    }
    if (arg.startsWith('--timezone=')) {
      options.timezone = arg.split('=')[1];
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    options.positional.push(arg);
  }

  return options;
};

const printHelp = () => {
  console.log(`Usage: node jpg_to_gpx.js <inputFolder> <outputGpx> [options]

Options:
  --split-distance-m <meters>  Split when adjacent points exceed distance (default: 200)
  --split-time-sec <seconds>   Split when adjacent points exceed time gap (default: 30)
  --timezone <offset>          Fallback timezone (+08:00 or +0800)
  --recursive                  Recursively scan input folder for JPG files
  --force                      Overwrite existing output GPX
  --version                    Show version
  --help                       Show this help

Examples:
  node jpg_to_gpx.js ./geocoded ./output.gpx
  node jpg_to_gpx.js ./geocoded ./output.gpx --split-distance-m 100 --timezone +08:00 --force
`);
};

const run = (options) => {
  if (options.help) {
    printHelp();
    return 0;
  }

  if (options.version) {
    console.log(`jpg-to-gpx version: ${packageJson.version}`);
    return 0;
  }

  if (options.positional.length !== 2) {
    printHelp();
    return 1;
  }

  if (
    !Number.isFinite(options.splitDistanceM) ||
    options.splitDistanceM < 0 ||
    !Number.isFinite(options.splitTimeSec) ||
    options.splitTimeSec < 0
  ) {
    console.error('Split thresholds must be non-negative numbers.');
    return 1;
  }

  const cliTimezoneMinutes = options.timezone ? parseTimezoneOffset(options.timezone) : null;
  if (options.timezone && cliTimezoneMinutes === null) {
    console.error(`Invalid timezone format: ${options.timezone}`);
    return 1;
  }

  const inputFolder = path.resolve(options.positional[0]);
  const outputGpx = path.resolve(options.positional[1]);

  if (!fs.existsSync(inputFolder) || !fs.statSync(inputFolder).isDirectory()) {
    console.error(`Input folder does not exist or is not readable: ${inputFolder}`);
    return 1;
  }

  if (fs.existsSync(outputGpx) && !options.force) {
    console.error(`Output GPX already exists: ${outputGpx}`);
    console.error('Use --force to overwrite.');
    return 1;
  }

  const jpgFiles = collectJpgFiles(inputFolder, options.recursive);
  if (jpgFiles.length === 0) {
    console.error(`No JPG files found in: ${inputFolder}`);
    return 1;
  }

  console.log(`Processing ${jpgFiles.length} JPG file(s) from: ${inputFolder}`);
  if (cliTimezoneMinutes !== null) {
    console.log(
      `CLI fallback timezone available: ${formatOffsetMinutes(cliTimezoneMinutes)} (--timezone)`
    );
  } else {
    console.log('CLI fallback timezone: not set');
  }
  console.log('Time priority: GPS tags > EXIF offset > filename offset > --timezone > filename datetime');
  console.log('');

  const skipCounts = {
    no_time: 0,
    no_gps: 0,
    read_error: 0,
    invalid_exif: 0,
  };
  const timeSourceCounts = {};
  const seenTimeSources = new Set();
  const timeMismatchWarnings = new Set();
  const records = [];

  for (const relPath of jpgFiles) {
    const record = readImageRecord(inputFolder, relPath, cliTimezoneMinutes);
    if (record.skipReason === 'no_time' || record.skipReason === 'read_error' || record.skipReason === 'invalid_exif') {
      skipCounts[record.skipReason] += 1;
      if (record.skipReason === 'no_time') {
        console.log(`Skip (no timezone-aware time): ${record.basename}`);
      }
      continue;
    }

    timeSourceCounts[record.timeSourceDescription] =
      (timeSourceCounts[record.timeSourceDescription] || 0) + 1;

    if (!seenTimeSources.has(record.timeSourceDescription)) {
      seenTimeSources.add(record.timeSourceDescription);
      console.log(`Time source: ${record.timeSourceDescription}`);
      console.log(`  example: ${record.basename}`);
    }

    if (record.timeMismatchWarning) {
      timeMismatchWarnings.add(record.timeMismatchWarning);
    }

    records.push(record);
    if (record.skipReason === 'no_gps') {
      skipCounts.no_gps += 1;
    }
  }

  const trackRecords = records.filter((record) => record.coordinates);
  if (trackRecords.length === 0) {
    console.error('No valid track points found.');
    return 1;
  }

  const {
    segments,
    splitEvents,
    distanceSplitCount,
    timeSplitCount,
    maxSplitDistanceM,
    maxSplitTimeSec,
  } = buildSegments(records, options.splitDistanceM, options.splitTimeSec);

  for (const event of splitEvents) {
    console.log(`Split: ${event.reasons.join('; ')}`);
    console.log(`  from: ${event.from}`);
    console.log(`  to:   ${event.to}`);
  }

  const gpxContent = buildGpxXml(segments);

  try {
    writeGpxAtomic(outputGpx, gpxContent);
  } catch (err) {
    console.error(`Failed to write GPX: ${err.message}`);
    return 1;
  }

  const skippedTotal = Object.values(skipCounts).reduce((sum, count) => sum + count, 0);

  console.log('');
  console.log('Summary');
  console.log(`  JPG files found: ${jpgFiles.length}`);
  console.log(`  Track points written: ${trackRecords.length}`);
  console.log(`  Skipped images: ${skippedTotal}`);
  console.log(`    no_time: ${skipCounts.no_time}`);
  console.log(`    no_gps: ${skipCounts.no_gps}`);
  console.log(`    read_error: ${skipCounts.read_error}`);
  console.log(`    invalid_exif: ${skipCounts.invalid_exif}`);
  console.log('  Time sources:');
  for (const [source, count] of Object.entries(timeSourceCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${source}: ${count}`);
  }
  console.log(`  Track segments: ${segments.length}`);
  console.log(`  Distance splits: ${distanceSplitCount} (max ${maxSplitDistanceM.toFixed(1)} m)`);
  console.log(`  Time splits: ${timeSplitCount} (max ${Math.round(maxSplitTimeSec)} s)`);
  console.log(`  Output GPX: ${outputGpx}`);

  if (skipCounts.no_time > 0) {
    console.log('');
    console.log(
      `Warning: ${skipCounts.no_time} image(s) skipped due to missing timezone-aware time; they cannot act as segment boundaries.`
    );
  }

  for (const basename of timeMismatchWarnings) {
    console.log(`Warning: EXIF time and filename time differ by >2s for ${basename}`);
  }

  return 0;
};

const main = () => {
  try {
    const options = parseCliArgs(process.argv);
    process.exit(run(options));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
};

if (require.main === module) {
  main();
}
