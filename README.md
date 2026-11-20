# Photos De-dupe Scripts

Node.js scripts for processing sequence photos taken by a mounted camera during driving. These scripts help to:

- Remove duplicate photos based on content similarity
- Filter out photos with identical GPS coordinates
- Filter out photos taken while moving slower than a speed threshold
- Calculate and write bearing (direction) information to photos

\* the base scripts are mainly created with ChatGPT 4o and Cousor with claude-3.5-sonnet

## [checkimg_content_dup.js](checkimg_content_dup.js)

This script identifies and moves near-identical consecutive images to an output folder, useful for removing redundant photos taken when the vehicle was stationary.

### Features

- Reads all `.jpg` images in the input folder
- Uses `Jimp` library for image comparison
- Multi-threaded processing (7 workers)
- Moves images to output folder when:
  - Content difference is less than 5%
  - Image distance is less than 0.016
- Preserves original files by moving duplicates to output folder

### Usage

1. Install dependencies:

    ```bash
    npm install jimp
    ```

2. Run the script:

    ```bash
    node checkimg_content_dup.js <inputFolder> <outputFolder>
    ```

## [checkimg_latlong_dup.js](checkimg_latlong_dup.js)

This script identifies and moves photos with identical GPS coordinates to an output folder, helping to remove redundant photos taken at the same location.

### Features

- Recursively processes all subfolders that contain `.jpg` images (same scan rules as `checkimg_speed_dupe.js` and `calcimg_dir.js`)
- Sorts images by EXIF `DateTimeOriginal` within each folder (falls back to file `mtime`)
- Uses `exif-parser` to extract GPS coordinates
- Compares consecutive images' GPS coordinates
- Moves removed images to the output folder, preserving paths relative to the input root
- Single-threaded processing per folder (avoids rename races)

### Usage

1. Install dependencies:

    ```bash
    npm install exif-parser
    ```

2. Run the script:

    ```bash
    node checkimg_latlong_dup.js <inputFolder> <outputFolder>
    ```

## [checkimg_speed_dupe.js](checkimg_speed_dupe.js)

This script identifies and moves photos taken while the vehicle was moving slower than a threshold (km/h), based on GPS and EXIF timestamps between **original adjacent** images. When a slow segment is detected, the **previous** image is moved so the **last** image in a stop sequence is kept (same behavior as `checkimg_latlong_dup.js`).

### Features

- Recursively processes all subfolders that contain `.jpg` images (same scan rules as `calcimg_dir.js`)
- Sorts images by EXIF `DateTimeOriginal` within each folder (falls back to file `mtime`)
- Splits photos into continuous capture sequences when adjacent shots are more than 30 seconds apart
- Uses `piexifjs` for EXIF GPS and timestamp reading
- Computes speed with Haversine distance between consecutive GPS points within each sequence
- Marks all removals first, then moves files once (no peel-back across non-adjacent photos)
- Skips moving when the destination file already exists (no silent overwrite)
- Moves removed images to the output folder, preserving paths relative to the input root
- Single-threaded processing per folder (avoids rename races)

### Tests

```bash
npm test
```

### Usage

1. Install dependencies:

    ```bash
    npm install piexifjs
    ```

2. Run the script:

    ```bash
    node checkimg_speed_dupe.js <inputFolder> <outputFolder> <minKph> [--until-stable]
    ```

    Example (remove segments slower than 5 km/h):

    ```bash
    node checkimg_speed_dupe.js ./photos ./removed 5
    ```

    加上 `--until-stable` 時，會重複以每輪剩餘照片重新判定，直到沒有照片被標記為止。若因輸出目錄已有同名檔而無法移動標記照片，程式會停止並回報尚未穩定，避免無限重跑。

### Suggested pipeline order

1. `geotag_with_gpx.js`
2. `checkimg_content_dup.js`
3. `checkimg_latlong_dup.js`
4. `checkimg_speed_dupe.js`
5. `calcimg_dir.js`
6. `jpg_to_gpx.js`

## [jpg_to_gpx.js](jpg_to_gpx.js)

Generate a segmented GPX track from JPG photos that already contain GPS EXIF
data. Unlike the old `exiftool -p gpx.fmt` flow, this tool splits
discontinuous photo sequences into separate `<trkseg>` blocks using distance
and time thresholds.

### Features

- Recursively reads all `.jpg` files under the input folder
- Groups photos by their containing folder and writes each folder as a named `<trk>`
- Reads EXIF GPS and capture time from `.jpg` files
- Sorts photos by resolved UTC timestamp
- Writes GPX 1.0 with multiple `<trkseg>` segments
- Batch mode creates one GPX for each first-level folder under a root folder
- Resolves time from GPS timestamps, EXIF `OffsetTimeOriginal`, filename timezone, or `--timezone` fallback
- Rejects coordinates that are missing latitude/longitude hemisphere references
- Reports skipped images by reason (`no_time`, `no_gps`, `read_error`, etc.)
- Uses atomic temp-file write before renaming output GPX

### Usage

1. Install dependencies:

    ```bash
    npm install piexifjs
    ```

2. Run the script:

    ```bash
    node jpg_to_gpx.js <inputFolder> <outputGpx>
    node jpg_to_gpx.js ./geocoded ./output.gpx --split-distance-m 200 --split-time-sec 30 --force
    node jpg_to_gpx.js ./geocoded ./output.gpx --timezone +08:00 --force
    node jpg_to_gpx.js --batch ./photos --timezone +08:00 --force
    ```

### Batch mode

`--batch <rootFolder>` processes each non-hidden first-level folder as an
independent GPX job. For example:

```text
photos/
├── trip-a/
│   ├── part-1/*.jpg
│   └── part-2/nested/*.jpg
└── trip-b/*.jpg
```

produces:

```text
photos/trip-a/trip-a.gpx
photos/trip-b/trip-b.gpx
```

Each GPX recursively includes all JPG files below its first-level input folder.
Photos are grouped by their containing folder. Each group is written as a
separate `<trk>` whose `<name>` is the relative folder path; existing distance,
time, and missing-GPS rules may split that track into multiple `<trkseg>`
elements. Tracks remain sorted by their first valid photo time and receive
sequential `<number>` values starting at `1`. JPG files directly under the
first-level input folder use that folder's name as the track name.

## [rename_by_exif_time.js](rename_by_exif_time.js)

Rename JPG files from their EXIF capture time.

### Features

- Recursively reads `.jpg` / `.jpeg` files by default
- Uses EXIF `DateTimeOriginal`, then `DateTimeDigitized`, then image `DateTime`
- Uses EXIF `OffsetTimeOriginal` / `OffsetTime` / `OffsetTimeDigitized` when present
- Falls back to `--timezone` when EXIF offset is missing
- Generates names like `2023-04-16T18-47-03+0800.jpg`
- Avoids overwrites by appending `_001`, `_002`, ...
- Dry-run by default; files are only renamed with `--apply`

### Usage

```bash
node rename_by_exif_time.js ./photos
node rename_by_exif_time.js ./photos --timezone +08:00 --apply
node rename_by_exif_time.js ./photos --prefix MAH06455_ --lower-ext --apply
```

## [delay_exif_time.js](delay_exif_time.js)

依相鄰照片的原始 EXIF 拍攝時間，累計調整連拍的時間偏移。需安裝 `exiftool`。

```bash
node delay_exif_time.js <timecriteriaMin> <timecriteriaMax> <delaysec> <inputFolder> <outfolder>
node delay_exif_time.js 5 6 1 geocoded geocoded-adjusted
node delay_exif_time.js 5 6 -1 geocoded geocoded-adjusted-earlier
node delay_exif_time.js 5 6 +0.2 geocoded geocoded-adjusted-fractional
```

- 讀完輸入目錄內所有非隱藏 `.jpg`／`.jpeg` 照片的原始 EXIF `DateTimeOriginal`，按拍攝時間由早到晚排序後再計算。
- 第一張的偏移為 0。原始間隔依 `DateTimeOriginal` 的整秒值判定，落在 `timecriteriaMin` 到 `timecriteriaMax` 的整秒範圍內（含上下限）時，該張與後續照片就再累加 `delaysec` 秒。`delaysec` 可填正負整數或小數，例如 `+0.2` 或 `-0.2`。
- 完成計算後，ExifTool 直接從原檔產生修正版副本。修正會計入原有的次秒，輸出整秒存於 `DateTimeOriginal`，次秒存於 `SubSecTimeOriginal`。無需修正的照片直接複製。整批完成並驗證後才建立指定的輸出目錄。輸出路徑須尚未存在。遇到缺少有效拍攝時間或寫入失敗時，整批停止。
- 執行時會顯示讀取、寫入、驗證與複製進度，並依原始拍攝時間逐張列出原始時間、間隔、觸發判定、累計偏移與預計輸出時間。

## [calibrate_exif_time.js](calibrate_exif_time.js)

用兩張照片的正確時間做線性校準，將固定比例的時間偏差套用到整批 JPEG。需安裝 `exiftool`。

```bash
node calibrate_exif_time.js <anchor1File> <anchor1CorrectTime> <anchor2File> <anchor2CorrectTime> <inputFolder> <outfolder> [--dry-run]

node calibrate_exif_time.js \
  IMG_20261116_100154_00_403.jpg 2026-11-16T10:31:45 \
  IMG_20261116_100154_00_418.jpg 2026-11-16T10:33:08 \
  geocoded ../geocoded-calibrated --dry-run
```

- 輸入兩張照片的完整檔名和正確時間。時間格式為 `YYYY-MM-DDTHH:mm:ss`，可加小數秒，並使用與照片 EXIF 相同的時區。
- 校準倍率為兩張照片的正確時間差除以原始 EXIF 時間差。原始時間差包含已有的次秒。以較早校準點的正確時間為基準，按此倍率縮放每張照片原始時間相對於該點的差值。區間外的照片也使用同一條公式外推。
- log 會列出校準點、倍率、逐張修正量、區間外的張數和整批首尾修正量。加上 `--dry-run` 可先預覽。執行寫入時，輸出目錄須尚未存在。
- 整秒與次秒分別寫入副本的 `DateTimeOriginal` 與 `SubSecTimeOriginal`，結果至少保留毫秒精度。整批輸出完成並驗證後才發布。

## [batch_image_transform.js](batch_image_transform.js)

批次旋轉、裁切既有的 JPEG。先在此目錄執行 `npm install`，並確認系統可執行 `exiftool`。

```bash
node batch_image_transform.js --input-dir geocoded --output-dir cropped \
  --rotate-deg 3 --crop-origin 69x133 --crop 2496x1264
```

一般模式先校正 EXIF 方向，再用 Sharp 順時針旋轉、裁切，最後重新編碼成 JPEG。`--crop-origin` 和影片轉檔的 `extract.js` 一樣，從旋轉後影像的左上角算起。`--jpeg-quality` 使用 1–100，預設 95。裁切框超出畫布時，該張照片會回報失敗。

只做無損裁切時，可使用 `--fast`，須另外安裝 `jpegtran`。這個模式的起點需對齊 JPEG 的 MCU，可用 `--suggest-fast-crop` 查詢建議值。

## [make_panoramax_csv.js](make_panoramax_csv.js)

遞迴掃描指定目錄下**每一個含有 JPEG 的子目錄**（含根目錄本身），依 EXIF 產生供 [Panoramax CLI](https://docs.panoramax.fr/cli/USAGE/#external-metadata) 使用的 `panoramax.csv`。

### Features

- `capture_time` 牆上時間來自 EXIF **`DateTimeOriginal`**；時區預設用 **`OffsetTimeOriginal`**。若指定 **`--timezone`** 則**強制覆寫**所有列的時區
- 每個有照片的資料夾各自寫入一份 `panoramax.csv`；目錄內所有 `.jpg`／`.jpeg` 都會列入
- UTF-8、LF、依檔名字典序排序

### Usage

```bash
# 對 20260814 下每個子目錄（例如 MIO）各產一份 panoramax.csv
node make_panoramax_csv.js "/Users/Irvin/Downloads/360 photos/wip/20260814"

# 只處理單一資料夾
node make_panoramax_csv.js "/Users/Irvin/Downloads/360 photos/wip/20260814/MIO"

# 強制所有 capture_time 使用 +12:00（忽略 EXIF OffsetTimeOriginal）
node make_panoramax_csv.js ./photos --timezone +12:00
```

## [calcimg_dir.js](calcimg_dir.js)

This script calculates (interpolates) and writes bearing (direction) information to each image's EXIF data based on GPS coordinates of consecutive images. The bearing of the first image will be set to the same as the second image.

### Features

- Reads all `.jpg` images in the input folder
- **Recursive folder processing**: Automatically detects and processes all subfolders containing images
- Sorts images by EXIF timestamp within each folder
- Uses `piexifjs` for EXIF reading/writing
- Multi-threaded processing (4 workers per folder)
- Calculates bearing between consecutive GPS coordinates
- Sets first image's bearing same as second image
- Supports optional bearing adjustment
- Modifies files in-place
- Skips empty folders or folders with insufficient GPS data

### Usage

1. Install dependencies:

    ```bash
    npm install piexifjs
    ```

2. Run the script:

    ```bash
    # Basic usage
    node calcimg_dir.js <inputFolder>

    # With bearing adjustment (e.g., add 10 degrees clockwise or subtract 15 degrees counter-clockwise)
    node calcimg_dir.js <inputFolder> 10
    node calcimg_dir.js <inputFolder> -15
    ```

## [geotag_with_gpx.js](geotag_with_gpx.js)
This script geotags photos by matching image timestamps with a GPX track.

### Features

- Recursively reads all `.jpg` images in the input folder.
- Writes GPS coordinates to images using a GPX file.
- Accepts an optional photo timezone offset (e.g., `+09:00`); when omitted, the system/local timezone is used.

### Usage

1. Install dependencies:

    ```bash
    npm install piexifjs
    ```

2. Run the script:

    ```bash
    # Basic usage (use the computer's local timezone for photo timestamps)
    node geotag_with_gpx.js <inputFolder> <gpxFile> <outputFolder>

    # Specify a timezone offset (e.g., UTC+9)
    node geotag_with_gpx.js <inputFolder> <gpxFile> <outputFolder> "+09:00"
    ```

## Install globally for command-line access

    ```bash
    npm install -g .
    ```

When installed globally, you can use these commands:

    ```bash
    checkimg-content-dup --version
    checkimg-latlong-dup --version
    checkimg-speed-dupe --version
    calcimg-dir --version
    jpg-to-gpx --version
    rename-by-exif-time --version
    calibrate-exif-time --help
    make-panoramax-csv --version
    ```

## License

This project is licensed under the MIT License. See the [LICENSE](/LICENSE) file for details.
