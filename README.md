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
    node checkimg_speed_dupe.js <inputFolder> <outputFolder> <minKph>
    ```

    Example (remove segments slower than 5 km/h):

    ```bash
    node checkimg_speed_dupe.js ./photos ./removed 5
    ```

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
    ```

## License

This project is licensed under the MIT License. See the [LICENSE](/LICENSE) file for details.
