#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function help() {
  console.log(`用法:
  node batch_image_transform.js --input-dir <目錄> --output-dir <目錄> --crop <WxH> [選項]

選項:
  --crop-origin <XxY>     裁切起點，預設 0x0
  --rotate-deg <N>        順時針旋轉，預設 0
  --jpeg-quality <N>      一般模式 JPEG quality，預設 95
  --concurrency <N>       平行處理數，預設 4
  --recursive             遞迴處理
  --overwrite             覆寫既有輸出
  --fast                  使用 jpegtran 無損裁切，不可旋轉
  --suggest-fast-crop     抽查 JPEG 並提出 MCU 對齊建議
  --sample-count <N>      建議模式抽查數，預設 10`);
}

function next(argv, i, name) {
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${name} 需要值`);
  return argv[++i];
}

function pair(value, name, zero = false) {
  const m = String(value).match(/^(\d+)x(\d+)$/i);
  const min = zero ? 0 : 1;
  if (!m || Number(m[1]) < min || Number(m[2]) < min) throw new Error(`${name} 格式錯誤`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

function args(argv) {
  const o = { cropOrigin: { x: 0, y: 0 }, rotate: 0, quality: 95, concurrency: 4, sampleCount: 10 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--input-dir') o.input = next(argv, i++, a);
    else if (a === '--output-dir') o.output = next(argv, i++, a);
    else if (a === '--crop') o.crop = pair(next(argv, i++, a), a);
    else if (a === '--crop-origin') o.cropOrigin = pair(next(argv, i++, a), a, true);
    else if (a === '--rotate-deg') o.rotate = Number(next(argv, i++, a));
    else if (a === '--jpeg-quality') o.quality = Number(next(argv, i++, a));
    else if (a === '--concurrency') o.concurrency = Math.max(1, Math.floor(Number(next(argv, i++, a))));
    else if (a === '--sample-count') o.sampleCount = Math.max(1, Math.floor(Number(next(argv, i++, a))));
    else if (a === '--recursive') o.recursive = true;
    else if (a === '--overwrite') o.overwrite = true;
    else if (a === '--fast') o.fast = true;
    else if (a === '--suggest-fast-crop') o.suggest = true;
    else throw new Error(`未知參數：${a}`);
  }
  if (!o.help && (!o.input || !o.crop || (!o.output && !o.suggest))) throw new Error('--input-dir、--crop、執行時的 --output-dir 都是必填');
  if (o.fast && o.rotate !== 0) throw new Error('--fast 不可搭配 --rotate-deg');
  return o;
}

function files(dir, recursive, rel = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    const nextRel = path.join(rel, e.name);
    if (e.isDirectory() && recursive) return files(full, true, nextRel);
    return e.isFile() && /\.jpe?g$/i.test(e.name) ? [{ full, rel: nextRel }] : [];
  }).sort((a, b) => a.rel.localeCompare(b.rel));
}

async function run(command, argv) {
  try {
    await execFileAsync(command, argv);
  } catch (error) {
    throw new Error(`${command} 失敗：${error.stderr || error.stdout || error.message}`.trim());
  }
}

function metadata(input) {
  const data = fs.readFileSync(input);
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new Error(`不是有效的 JPEG：${input}`);
  }
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < data.length) {
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset >= data.length) break;
    const marker = data[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) break;
    const length = data.readUInt16BE(offset);
    const start = offset + 2;
    if (length < 2 || offset + length > data.length) break;
    if (sofMarkers.has(marker)) {
      const components = data[start + 5];
      if (start + 6 + components * 3 > offset + length) break;
      let maxH = 1;
      let maxV = 1;
      for (let i = 0; i < components; i++) {
        const factor = data[start + 7 + i * 3];
        maxH = Math.max(maxH, factor >> 4);
        maxV = Math.max(maxV, factor & 0x0f);
      }
      return {
        width: data.readUInt16BE(start + 3),
        height: data.readUInt16BE(start + 1),
        sampling: `${maxH}x${maxV}`,
      };
    }
    offset += length;
  }
  throw new Error(`無法讀取 JPEG 尺寸與 sampling：${input}`);
}

function mcu(sampling) {
  const factors = [...String(sampling).matchAll(/(\d+)x(\d+)/g)];
  const maxH = Math.max(1, ...factors.map((match) => Number(match[1])));
  const maxV = Math.max(1, ...factors.map((match) => Number(match[2])));
  return { w: maxH * 8, h: maxV * 8 };
}

function validateFastCropOrigin(source, cropOrigin) {
  const size = mcu(source.sampling);
  if (cropOrigin.x % size.w !== 0 || cropOrigin.y % size.h !== 0) {
    throw new Error(
      `--fast 的 crop-origin ${cropOrigin.x}x${cropOrigin.y} 未對齊 MCU ${size.w}x${size.h}；請先使用 --suggest-fast-crop`
    );
  }
}

function suggest(source, crop) {
  const size = mcu(source.sampling);
  const right = crop.x + crop.width;
  const bottom = crop.y + crop.height;
  const make = (left, top, r, b) => ({ left, top, width: Math.max(0, Math.min(r, source.width) - left), height: Math.max(0, Math.min(b, source.height) - top) });
  return {
    mcu: size,
    inward: make(Math.ceil(crop.x / size.w) * size.w, Math.ceil(crop.y / size.h) * size.h, Math.floor(right / size.w) * size.w, Math.floor(bottom / size.h) * size.h),
    outward: make(Math.floor(crop.x / size.w) * size.w, Math.floor(crop.y / size.h) * size.h, Math.ceil(right / size.w) * size.w, Math.ceil(bottom / size.h) * size.h),
  };
}

function samples(list, count) {
  const n = Math.min(list.length, count);
  return [...new Set(Array.from({ length: n }, (_, i) => Math.round(i * (list.length - 1) / Math.max(1, n - 1))))].map((i) => list[i]);
}

function validateSampleConsistency(checked) {
  const first = checked[0];
  const mismatch = checked.find((item) =>
    item.width !== first.width ||
    item.height !== first.height ||
    item.sampling !== first.sampling
  );
  if (mismatch) {
    throw new Error(
      `抽查 JPEG 規格不一致：基準 ${first.width}x${first.height} sampling=${first.sampling}，` +
      `發現 ${mismatch.width}x${mismatch.height} sampling=${mismatch.sampling}`
    );
  }
  return first;
}

function normalTransformArgs(job, o, temp) {
  const geometry = `${o.crop.x}x${o.crop.y}+${o.cropOrigin.x}+${o.cropOrigin.y}`;
  return [
    job.input,
    '-auto-orient',
    '-background',
    'black',
    '-rotate',
    String(o.rotate),
    '-crop',
    geometry,
    '+repage',
    '-quality',
    String(o.quality),
    temp,
  ];
}

function validateOutputDimensions(actual, requested) {
  if (actual.width !== requested.x || actual.height !== requested.y) {
    throw new Error(
      `裁切結果為 ${actual.width}x${actual.height}，不符合要求的 ${requested.x}x${requested.y}；請檢查裁切邊界`
    );
  }
}

async function transform(job, o) {
  fs.mkdirSync(path.dirname(job.output), { recursive: true });
  if (!o.overwrite && fs.existsSync(job.output)) return 'skipped';
  const geometry = `${o.crop.x}x${o.crop.y}+${o.cropOrigin.x}+${o.cropOrigin.y}`;
  const temp = `${job.output}.transform.tmp.jpg`;
  try {
    if (o.fast) {
      validateFastCropOrigin(metadata(job.input), o.cropOrigin);
      await run('jpegtran', ['-copy', 'all', '-perfect', '-crop', geometry, '-outfile', temp, job.input]);
    }
    else await run('magick', normalTransformArgs(job, o, temp));
    validateOutputDimensions(metadata(temp), o.crop);
    if (!o.fast) {
      await run('exiftool', ['-overwrite_original', `-TagsFromFile=${job.input}`, '-all:all', '-unsafe', '-icc_profile', '-Orientation#=1', `-ExifImageWidth=${o.crop.x}`, `-ExifImageHeight=${o.crop.y}`, temp]);
    }
    fs.renameSync(temp, job.output);
  } finally {
    try { fs.unlinkSync(temp); } catch (_) { /* no temporary file */ }
  }
  return 'written';
}

async function updateFastOutputDimensions(outputDir, recursive, crop) {
  const commandArgs = [
    '-overwrite_original',
    `-ExifImageWidth=${crop.x}`,
    `-ExifImageHeight=${crop.y}`,
    '-ext', 'jpg',
  ];
  if (recursive) commandArgs.push('-r');
  commandArgs.push(outputDir);
  await run('exiftool', commandArgs);
}

async function main() {
  const o = args(process.argv);
  if (o.help) return help();
  const list = files(o.input, o.recursive);
  if (list.length === 0) throw new Error('輸入目錄沒有 JPEG');
  if (o.suggest) {
    const checked = samples(list, o.sampleCount).map((f) => metadata(f.full));
    const source = validateSampleConsistency(checked);
    const s = suggest(source, { x: o.cropOrigin.x, y: o.cropOrigin.y, width: o.crop.x, height: o.crop.y });
    console.log(`files: ${list.length}\nsampled: ${checked.length}\nsource: ${source.width}x${source.height}\nsampling: ${source.sampling}\nMCU: ${s.mcu.w}x${s.mcu.h}`);
    console.log(`inward: ${s.inward.left}x${s.inward.top} + ${s.inward.width}x${s.inward.height}`);
    console.log(`outward: ${s.outward.left}x${s.outward.top} + ${s.outward.width}x${s.outward.height}`);
    return;
  }
  let cursor = 0; let written = 0; let skipped = 0; let failed = 0;
  async function worker() {
    while (cursor < list.length) {
      const i = cursor++; const f = list[i];
      try { const status = await transform({ input: f.full, output: path.join(o.output, f.rel) }, o); status === 'written' ? written++ : skipped++; }
      catch (e) { failed++; console.error(`失敗：${f.full}：${e.message}`); }
      const done = written + skipped + failed; if (done === 1 || done % 100 === 0 || done === list.length) console.log(`進度：${done}/${list.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(o.concurrency, list.length) }, worker));
  if (o.fast && written > 0) {
    await updateFastOutputDimensions(o.output, o.recursive, o.crop);
    console.log(`metadata：更新 ${o.crop.x}x${o.crop.y} 尺寸欄位`);
  }
  console.log(`完成：written=${written} skipped=${skipped} failed=${failed}`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}

module.exports = {
  args,
  mcu,
  metadata,
  normalTransformArgs,
  suggest,
  validateFastCropOrigin,
  validateOutputDimensions,
  validateSampleConsistency,
};
