# Photos De-dupe Scripts

Node.js scripts for processing sequence photos taken by a mounted camera during driving - remove duplicates based on content comparison and duplicate GPS coordinates.

## `checkimg_content_dup.js`

This script compares the content similarity between consecutive images and moves images with minimal differences (indicating that the vehicle was likely stopped) to the output folder.

### Features

- Reads all `.jpg` images in the input folder.
- Uses the `Jimp` library to compare the content differences between consecutive images.
- Moves the current image to the output folder if the differences and distance between two images are minimal.

### Usage

1. Install dependencies:

    ```bash
    npm install jimp
    ```

2. Run the script:

    ```bash
    node checkimg_content_dup.js <inputFolder> <outputFolder>
    ```

## `checkimg_latlong_dup.js`

This script compares the GPS coordinates between consecutive images and moves images with identical coordinates to the output folder, filter out redundant images captured at the same location.

### Features

- Reads all `.jpg` images in the input folder.
- Extracts GPS coordinates from the EXIF data of each image using the `exif-parser` library.
- Compares the GPS coordinates between consecutive images.
- Moves the current image to the output folder if the GPS coordinates of two consecutive images are identical.

### Usage

1. Install dependencies:

    ```bash
    npm install exif-parser
    ```

2. Run the script:

    ```bash
    node checkimg_latlong_dup.js <inputFolder> <outputFolder>
    ```

## License

This project is licensed under the MIT License. See the [LICENSE](/LICENSE) file for details.