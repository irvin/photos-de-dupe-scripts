#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

function run(command, argv) {
  const result = spawnSync(command, argv, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} 失敗：${result.stderr || result.stdout}`.trim());
}

function metadata(input) {
  const r = spawnSync('identify', ['-format', '%w %h %[jpeg:sampling-factor]', input], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`無法讀取 JPEG：${input}`);
  const m = r.stdout.trim().match(/^(\d+) (\d+) (.+)$/);
  return { width: Number(m[1]), height: Number(m[2]), sampling: m[3] };
}

function mcu(sampling) {
  if (/2x2/.test(sampling)) return { w: 16, h: 16 };
  if (/2x1/.test(sampling)) return { w: 16, h: 8 };
  return { w: 8, h: 8 };
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

function transform(job, o) {
  fs.mkdirSync(path.dirname(job.output), { recursive: true });
  if (!o.overwrite && fs.existsSync(job.output)) return 'skipped';
  const geometry = `${o.crop.x}x${o.crop.y}+${o.cropOrigin.x}+${o.cropOrigin.y}`;
  const temp = `${job.output}.transform.tmp.jpg`;
  if (o.fast) run('jpegtran', ['-copy', 'all', '-perfect', '-crop', geometry, '-outfile', temp, job.input]);
  else run('magick', [job.input, '-background', 'black', '-rotate', String(o.rotate), '-crop', geometry, '+repage', '-quality', String(o.quality), temp]);
  run('exiftool', ['-overwrite_original', `-TagsFromFile=${job.input}`, '-all:all', '-unsafe', '-icc_profile', '-Orientation#=1', `-ExifImageWidth=${o.crop.x}`, `-ExifImageHeight=${o.crop.y}`, temp]);
  fs.renameSync(temp, job.output);
  return 'written';
}

async function main() {
  const o = args(process.argv);
  if (o.help) return help();
  const list = files(o.input, o.recursive);
  if (list.length === 0) throw new Error('輸入目錄沒有 JPEG');
  if (o.suggest) {
    const checked = samples(list, o.sampleCount).map((f) => metadata(f.full));
    const s = suggest({ ...checked[0] }, { x: o.cropOrigin.x, y: o.cropOrigin.y, width: o.crop.x, height: o.crop.y });
    console.log(`files: ${list.length}\nsampled: ${checked.length}\nsource: ${checked[0].width}x${checked[0].height}\nsampling: ${checked[0].sampling}\nMCU: ${s.mcu.w}x${s.mcu.h}`);
    console.log(`inward: ${s.inward.left}x${s.inward.top} + ${s.inward.width}x${s.inward.height}`);
    console.log(`outward: ${s.outward.left}x${s.outward.top} + ${s.outward.width}x${s.outward.height}`);
    return;
  }
  let cursor = 0; let written = 0; let skipped = 0; let failed = 0;
  async function worker() {
    while (cursor < list.length) {
      const i = cursor++; const f = list[i];
      try { const status = transform({ input: f.full, output: path.join(o.output, f.rel) }, o); status === 'written' ? written++ : skipped++; }
      catch (e) { failed++; console.error(`失敗：${f.full}：${e.message}`); }
      const done = written + skipped + failed; if (done === 1 || done % 100 === 0 || done === list.length) console.log(`進度：${done}/${list.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(o.concurrency, list.length) }, worker));
  console.log(`完成：written=${written} skipped=${skipped} failed=${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
