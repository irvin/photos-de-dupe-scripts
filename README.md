# Photos De-dupe Scripts

Node.js scripts for processing sequence photos taken by a mounted camera during driving. These scripts help to:

- Remove duplicate photos based on content similarity
- Filter out photos with identical GPS coordinates
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

- Reads all `.jpg` images in the input folder
- Uses `exif-parser` to extract GPS coordinates
- Multi-threaded processing (4 workers)
- Compares consecutive images' GPS coordinates
- Preserves original files by moving duplicates to output folder

### Usage

1. Install dependencies:

    ```bash
    npm install exif-parser
    ```

2. Run the script:

    ```bash
    node checkimg_latlong_dup.js <inputFolder> <outputFolder>
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
This script geotags images with a GPX file.

### Features

- Reads all `.jpg` images in the input folder recursively
- writes GPS data to images from GPX file

### Usage

1. Install dependencies:

    ```bash
    npm install piexifjs
    ```

2. Run the script:

    ```bash
    node geotag_with_gpx.js <inputFolder> <gpxFile> <outputFolder>
    ```

## Install globally for command-line access

    ```bash
    npm install -g .
    ```

When installed globally, you can use these commands:

    ```bash
    checkimg-content-dup --version
    checkimg-latlong-dup --version
    calcimg-dir --version
    ```

## License

This project is licensed under the MIT License. See the [LICENSE](/LICENSE) file for details.
