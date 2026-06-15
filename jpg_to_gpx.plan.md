# JPG EXIF to Segmented GPX Tool Plan

## 目的

在 `photos-de-dupe-scripts` 新增一個 NodeJS CLI 工具，從已具備 GPS EXIF
資訊的 JPG 照片產生 GPX 軌跡。工具必須將不連續的照片拆成不同
`<trkseg>`，避免 GPX 檢視器將兩段相隔很遠的拍攝路線畫成一條跨區域直線。

預定檔案與命令名稱：

- 實作檔：`jpg_to_gpx.js`
- `package.json` bin：`jpg-to-gpx`

## 背景與已確認問題

目前使用方式：

```bash
exiftool -p "/Users/Irvin/Coding/360-street-view-photos-processing/gpx.fmt" \
  -ee -d %Y-%m-%dT%H:%M:%SZ -fileOrder gpsdatetime \
  geocoded/*.jpg > output.gpx
```

以 `/Users/Irvin/Downloads/360 photos/wip/MIO_out/20260523/geocoded` 為樣本：

- 現有 `20260523.gpx` 將全部有效點寫入單一 `<trkseg>`，GPX Editor 因此在
  不連續路段間畫出長直線。
- 現有 GPX 顯示 2,653 個 track points，資料夾中也有 2,653 張 JPG；新工具
  應明確回報輸入、輸出點數與被略過的圖片原因。
- 抽查照片可取得 `GPSLatitude`、`GPSLongitude`、`GPSAltitude` 與
  `DateTimeOriginal`、`GPSDateStamp`，但未取得可與 UTC 日期組成完整
  GPS 時間的 `GPSTimeStamp`（ExifTool 的 `$gpsdatetime` 需兩者組合）；
  現有 GPX 因此沒有 `<time>` 值。
- 檔名包含當地時間與時區，例如
  `2026-05-23T07-26-10+0800_f00300.jpg`，可作為 EXIF 未帶 timezone 時的
  時間後備來源。

## 範圍

### 要做

- 從輸入資料夾讀取 `.jpg` / `.JPG` 照片的 EXIF GPS 與拍攝時間。
- 按實際拍攝時間排序照片，而不是依檔案列舉順序排序。
- 依照片所在資料夾輸出多個具名 `<trk>`，每個 `<trk>` 可包含多個
  `<trkseg>`。
- 以可設定的距離與時間門檻切斷軌跡。
- 支援批次處理 root 第一層的每個資料夾，在各資料夾內產生同名 GPX。
- 在終端輸出處理摘要與每個切段原因。
- 加入 `README.md` 使用說明及 `package.json` CLI 入口。

### 不做

- 不修改照片 EXIF。
- 不搬移、去重或刪除照片。
- 不依道路資料推測兩點間的行駛路線。
- 不取代 `geotag_with_gpx.js`、`checkimg_*` 或 `calcimg_dir.js` 的功能。

### Pipeline 定位

- 取代根目錄 `readme.md` 步驟 9 的 `exiftool -p gpx.fmt ...` 命令。
- 建議在 `calcimg_dir.js` 之後、上傳 Panoramax / Mapillary 之前執行。
- 與 Panoramax `--split-distance 200` 使用相同距離慣例，但 GPX 切段是
  獨立步驟，不依賴上傳工具。

## CLI 規格

```bash
node jpg_to_gpx.js <inputFolder> <outputGpx> [options]
node jpg_to_gpx.js --batch <rootFolder> [options]
```

安裝成全域指令後：

```bash
jpg-to-gpx <inputFolder> <outputGpx> [options]
jpg-to-gpx --batch <rootFolder> [options]
```

### 選項

| 選項 | 預設值 | 說明 |
| --- | --- | --- |
| `--batch <rootFolder>` | 無 | 處理 root 第一層的每個非隱藏資料夾，在各資料夾內產生 `<資料夾名>.gpx`。 |
| `--split-distance-m <meters>` | `200` | 相鄰有效點距離大於此值時開始新的 `<trkseg>`。 |
| `--split-time-sec <seconds>` | `30` | 相鄰有效點時間差大於此值時開始新的 `<trkseg>`。 |
| `--timezone <offset>` | 無 | 後備時區。接受 `+08:00` 或 `+0800` 格式。 |
| `--force` | `false` | 允許覆蓋既有輸出 GPX；未指定且輸出檔已存在時終止。 |
| `--version` | - | 顯示工具版本。 |
| `--help` | - | 顯示參數與範例。 |

距離預設值採 `200 m`，與此 repo 文件中 Panoramax 上傳的
`--split-distance 200` 慣例一致，也遠高於樣本連續一秒照片常見的約
5 至 16 公尺位移。

### 使用範例

```bash
node jpg_to_gpx.js \
  "/Users/Irvin/Downloads/360 photos/wip/MIO_out/20260523/geocoded" \
  "/Users/Irvin/Downloads/360 photos/wip/MIO_out/20260523/20260523-segmented.gpx"
```

```bash
node jpg_to_gpx.js ./geocoded ./output.gpx \
  --split-distance-m 100 \
  --split-time-sec 10 \
  --timezone +08:00 \
  --force
```

```bash
node jpg_to_gpx.js --batch ./photos --timezone +08:00 --force
```

> 注意：本工具會遞迴掃描輸入資料夾下所有子目錄中的 JPG，與
> `geotag_with_gpx.js` 的收集方式一致。

批次模式只把 root 第一層資料夾視為獨立工作；root 直屬 JPG 不處理。
每個工作會遞迴收集其下所有 JPG。

## 輸入資料與欄位規則

### GPS 座標

- 必要欄位：`GPSLatitude`、`GPSLongitude`。
- 選用欄位：`GPSAltitude`；無高度時省略該點的 `<ele>`。
- 座標轉換沿用 `checkimg_speed_dupe.js` 的 `convertDMSToDD` 邏輯
  （DMS rational → 十進位，參考 `GPSLatitudeRef` / `GPSLongitudeRef`
  決定正負）。
- 下列情況視為無效 GPS，等同「無有效 latitude/longitude」：
  - 缺 `GPSLatitude` 或 `GPSLongitude`。
  - DMS 陣列格式錯誤。
  - `GPSLatitudeRef` 不是 `N` / `S`，或 `GPSLongitudeRef` 不是 `E` / `W`。
  - 轉換後 lat 不在 [-90, 90] 或 lon 不在 [-180, 180]。
- `GPSAltitude`：自 piexif rational 轉為公尺；若存在
  `GPSAltitudeRef === 1`（海平面下），高度取負值。
- 無有效 latitude/longitude、但可解析時間的圖片不輸出為 track point，仍
  依時間插入排序序列作為軌跡中斷標記，避免跳過無座標圖片後錯誤連接前後點。

### 時間來源優先順序

每張圖片必須解析出含時區、可轉為 UTC 的時間。優先順序如下：

1. EXIF `GPSDateStamp` + `GPSTimeStamp` 組合：
   - 兩者皆存在且可解析時，視為 UTC 時間（與 ExifTool `$gpsdatetime`
     行為一致）。
   - 僅存在其一，或解析失敗，fall through 到下一項。
2. EXIF `DateTimeOriginal` 搭配 EXIF `OffsetTimeOriginal`（tag `0x9011`）。
3. EXIF `DateTimeOriginal` 搭配檔名中的 timezone offset，例如 `+0800`。
4. EXIF `DateTimeOriginal` 搭配命令列 `--timezone`。
5. 從完整檔名時間格式直接解析，例如
   `2026-05-23T07-26-10+0800_f00300.jpg`。
   - 僅當第 1–4 項皆無法取得時間時使用；此時以檔名時間為準，
     不再嘗試與 EXIF `DateTimeOriginal` 合併。

若仍無法取得含時區的時間，略過該圖片並回報原因。由於這種圖片無法放入
可靠的時間順序，不能作為前後軌跡的中斷標記；此邊界必須顯示在摘要警告中。
不以 filesystem `mtime` 取代拍攝時間，因為複製或匯出照片會改變該值。

### 時間一致性警告

當第 1 至第 4 項成功，且檔名中亦含完整可解析時間時，若兩者 UTC 時間
相差超過 2 秒，摘要中輸出 warning，但仍以優先順序選出的 metadata 時間
為準。

### 略過原因分類

| 原因代碼 | 說明 | 是否可作為 segment boundary |
| --- | --- | --- |
| `no_time` | 無法解析含時區的時間 | 否 |
| `no_gps` | 有時間但無有效 GPS | 是 |
| `read_error` | 檔案讀取或 EXIF 解析失敗 | 否（無法排序） |
| `invalid_exif` | EXIF 結構損壞 | 否 |

### 排序

- 依解析後的 UTC timestamp 由小到大排序。
- timestamp 相同時依完整相對路徑字典序排序，確保輸出可重現。

## 切段規則

工具先依時間排序**所有**可解析時間的圖片（含無 GPS 者），再線性掃描
此序列建立 segments。

遇到每個**有效 GPS 點**時，判斷是否開啟新 `<trkseg>`。下列任一條件
成立時，該點成為新 segment 的第一點：

- 這是第一個有效 GPS 點。
- 自上一個有效 GPS 點以來，排序序列中出現過「有時間但無有效 GPS」
  的圖片（含一張或多張）。
- 與上一有效 GPS 點的 Haversine 距離 `> --split-distance-m`。
- 與上一有效 GPS 點的 UTC 時間差 `> --split-time-sec`。

補充規則：

- 距離或時間剛好等於門檻時維持同一 segment。
- 不因距離為 `0` 而略過點；去重屬於其他既有工具的責任。
- 只含單一 track point 的 segment 仍應保留，因為該照片位置仍是有效資料。
- 若全部圖片均無有效 GPS 與時間，工具回傳非零 exit code，不建立 GPX。

## GPX 輸出格式

輸出維持目前 `gpx.fmt` 可被 GPX Editor 開啟的 GPX 1.0 結構；creator
改為工具名稱。所有文字欄位必須進行 XML escaping。

與現有 `gpx.fmt` 輸出之差：

- `<ele>` 僅在高度有效時輸出（`gpx.fmt` 恆輸出該 tag）。
- 每個含有效 GPS 照片的資料夾建立一個 `<trk>`，並以相對資料夾路徑
  寫入 `<trk><name>`。
- `<trk>` 依第一個有效 GPS 點的時間排序，並按輸出順序寫入從 `1`
  開始遞增的 `<number>`。
- 多個 `<trkseg>` 而非單一 segment。
- `<time>` 來自本工具時間解析規則，不再依賴 `$gpsdatetime`。

```xml
<?xml version="1.0" encoding="utf-8"?>
<gpx version="1.0"
 creator="jpg-to-gpx"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
 xmlns="http://www.topografix.com/GPX/1/0"
 xsi:schemaLocation="http://www.topografix.com/GPX/1/0 http://www.topografix.com/GPX/1/0/gpx.xsd">
 <trk>
   <name>part-1</name>
   <number>1</number>
   <trkseg>
     <trkpt lat="24.993003" lon="121.508817666667">
       <ele>77.3</ele>
       <time>2026-05-22T23:26:10Z</time>
       <name>2026-05-23T07-26-10+0800_f00300.jpg</name>
     </trkpt>
   </trkseg>
   <trkseg>
     <!-- 另一段不連續軌跡 -->
   </trkseg>
 </trk>
 <trk>
   <name>part-2/nested</name>
   <number>2</number>
   <trkseg>
     <!-- 另一個照片資料夾的軌跡 -->
   </trkseg>
 </trk>
</gpx>
```

### Track point 欄位

| GPX 欄位 | 來源 | 規則 |
| --- | --- | --- |
| `lat` | `GPSLatitude` | 十進位座標，保留讀取值精度。 |
| `lon` | `GPSLongitude` | 十進位座標，保留讀取值精度。 |
| `<ele>` | `GPSAltitude` | 有值時輸出，單位為公尺。 |
| `<time>` | 上述時間選擇規則 | 一律輸出 UTC ISO 8601 `YYYY-MM-DDTHH:mm:ssZ`。 |
| `<name>` | 檔名 | 只輸出 basename，不寫入本機絕對路徑。 |

## 終端輸出與錯誤處理

成功時摘要至少包含：

- 找到的 JPG 數量。
- 輸出的 track point 數量。
- 略過圖片數量，以及按原因分類的計數。
- 產生的 `<trkseg>` 數量。
- 因距離門檻切段的數量及最大斷點距離。
- 因時間門檻切段的數量及最大斷點時間差。
- 輸出 GPX 路徑。

每個切段事件輸出前一點與後一點的檔名，以及切段觸發值，例如：

```text
Split: distance 3521.4 m > 200 m; time 39679 s > 30 s
  from: 2026-05-23T07-37-08+0800_f01170.jpg
  to:   2026-05-23T18-43-27+0800_f00165.jpg
```

摘要中 distance / time 切段計數可各自獨立統計（同一次 split 兩者都 +1）。

### 檔案寫入

- 若輸出 GPX 的父目錄不存在，自動建立（`mkdirSync` recursive）。
- 暫存檔寫在輸出 GPX 同目錄，檔名為 `.<basename>.tmp`；
  成功後再 `rename` 至目標路徑。
- 若 `--force` 未指定且輸出檔已存在，不寫入、不建立暫存檔。

下列狀況應以非零 exit code 結束：

- 輸入資料夾不存在或不可讀。
- 輸出路徑已存在且未提供 `--force`。
- 門檻或 timezone 參數格式不合法（timezone 僅接受 `±HH:MM` 或
  `±HHMM` 格式）。
- 沒有找到 JPG。
- 沒有任何可輸出的有效 track point。
- 寫入 GPX 失敗。

單一圖片 metadata 無效屬於可恢復錯誤：略過、回報，但若仍有有效點就輸出
GPX。

- 有有效 track point 且 GPX 寫入成功：exit `0`，即使部分圖片被略過。
- 有略過圖片時，摘要必須以 skip breakdown 呈現；若存在 `no_time`
  略過，額外輸出一行 summary warning。

## 實作約束

- 使用 CommonJS 與 Node.js，風格比照此 package 既有 scripts。
- 檔案首行：`#!/usr/bin/env node`。
- `package.json` bin 條目：`"jpg-to-gpx": "./jpg_to_gpx.js"`。
- `--version` / `--help` 行為比照 `geotag_with_gpx.js`。
- 沿用目前相依套件 `piexifjs` 讀取 GPS 與既有 EXIF 欄位；由於其不公開
  EXIF 2.31 的 `OffsetTimeOriginal`，工具從 JPEG APP1/TIFF 結構額外讀取
  tag `0x9011`。不要求使用者安裝或呼叫外部 `exiftool` 才能產生 GPX。
- Haversine 距離計算沿用 `checkimg_speed_dupe.js` 的 `distanceKm`，
  比較門檻前轉換為公尺（`distanceKm * 1000`）。
- GPS 座標轉換（`convertDMSToDD`）與 EXIF 讀取模式（`piexif.load`）
  亦沿用該檔案風格。
- 逐張讀取 JPG、提取 EXIF 後即可釋放該張 binary；不得同時保留
  所有照片的 JPEG 內容於記憶體。允許使用 `piexifjs` 的
  `readFileSync` + `piexif.load` 模式（與既有 scripts 一致）。
- 寫入時先建立完整內容至暫存檔，成功後再 rename 至輸出路徑，避免中途中斷
  留下不完整 GPX。

## 驗收條件

### 人工驗證

以 `20260523/geocoded`、`20260524/geocoded` 產生新的 segmented GPX：

- 工具應報告實際輸入數、有效點數、略過數與 segment 數。
- `20260523` 目前應可輸出 2,653 個點且不略過圖片；若來源資料後續有變動，
  略過原因須由 summary 明確說明。
- 輸出應包含 `<time>` 值，GPX Editor 不再顯示 `no time values`。
- 任一同一 `<trkseg>` 內的相鄰點均不得超過設定的距離或時間門檻。
- 在 GPX Editor 開啟輸出後，不應再出現跨越不連續拍攝地點的長直線。

## 實作工作項目

1. 新增 `jpg_to_gpx.js`（參數解析、JPG 掃描、EXIF 讀取）。
2. 實作時間解析（含 GPSDateStamp/GPSTimeStamp 組合與檔名 fallback）
   及 GPS 有效性判斷。
3. 實作排序、segment 分割（含無 GPS 中斷標記）與 Haversine 距離。
4. 實作 GPX 寫入（XML escape、atomic rename）與摘要 / 警告輸出。
5. 在 `package.json` 註冊 `jpg-to-gpx` bin。
6. 更新 `README.md` 與根目錄 `readme.md` 步驟 9。
7. 以 `20260523` 與 `20260524` 實際 GPX 進行人工檢視。
