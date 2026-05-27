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
- 現有 GPX 顯示 2,653 個 track points，而資料夾中有 2,654 張 JPG；新工具
  應明確回報被略過的圖片與原因。
- 抽查照片可取得 `GPSLatitude`、`GPSLongitude`、`GPSAltitude` 與
  `DateTimeOriginal`，但未取得可供上述指令輸出的 `GPSDateTime` /
  `GPSTimeStamp`；現有 GPX 因此沒有 `<time>` 值。
- 檔名包含當地時間與時區，例如
  `2026-05-23T07-26-10+0800_f00300.jpg`，可作為 EXIF 未帶 timezone 時的
  時間後備來源。

## 範圍

### 要做

- 從輸入資料夾讀取 `.jpg` / `.JPG` 照片的 EXIF GPS 與拍攝時間。
- 按實際拍攝時間排序照片，而不是依檔案列舉順序排序。
- 輸出一個包含一個 `<trk>`、多個 `<trkseg>` 的 GPX 檔案。
- 以可設定的距離與時間門檻切斷軌跡。
- 在終端輸出處理摘要與每個切段原因。
- 加入 `README.md` 使用說明及 `package.json` CLI 入口。

### 不做

- 不修改照片 EXIF。
- 不搬移、去重或刪除照片。
- 不依道路資料推測兩點間的行駛路線。
- 不取代 `geotag_with_gpx.js`、`checkimg_*` 或 `calcimg_dir.js` 的功能。

## CLI 規格

```bash
node jpg_to_gpx.js <inputFolder> <outputGpx> [options]
```

安裝成全域指令後：

```bash
jpg-to-gpx <inputFolder> <outputGpx> [options]
```

### 選項

| 選項 | 預設值 | 說明 |
| --- | --- | --- |
| `--split-distance-m <meters>` | `200` | 相鄰有效點距離大於此值時開始新的 `<trkseg>`。 |
| `--split-time-sec <seconds>` | `30` | 相鄰有效點時間差大於此值時開始新的 `<trkseg>`。 |
| `--timezone <+HH:MM>` | 無 | `DateTimeOriginal` 沒有時區，且檔名也無法提供時區時使用的後備時區。 |
| `--recursive` | `false` | 遞迴尋找輸入資料夾下的 JPG。未指定時只處理資料夾第一層。 |
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

## 輸入資料與欄位規則

### GPS 座標

- 必要欄位：`GPSLatitude`、`GPSLongitude`。
- 選用欄位：`GPSAltitude`；無高度時省略該點的 `<ele>`。
- 無有效 latitude/longitude、但可解析時間的圖片不輸出為 track point，仍
  依時間插入排序序列作為軌跡中斷標記，避免跳過無座標圖片後錯誤連接前後點。

### 時間來源優先順序

每張圖片必須解析出含時區、可轉為 UTC 的時間。優先順序如下：

1. EXIF `GPSDateTime`，若完整且有效。
2. EXIF `DateTimeOriginal` 搭配 EXIF `OffsetTimeOriginal`。
3. EXIF `DateTimeOriginal` 搭配檔名中的 timezone，例如 `+0800`。
4. EXIF `DateTimeOriginal` 搭配命令列 `--timezone`。
5. 從完整檔名時間格式直接解析，例如
   `2026-05-23T07-26-10+0800_f00300.jpg`。

若仍無法取得含時區的時間，略過該圖片並回報原因。由於這種圖片無法放入
可靠的時間順序，不能作為前後軌跡的中斷標記；此邊界必須顯示在摘要警告中。
不以 filesystem `mtime` 取代拍攝時間，因為複製或匯出照片會改變該值。

### 排序

- 依解析後的 UTC timestamp 由小到大排序。
- timestamp 相同時依完整相對路徑字典序排序，確保輸出可重現。

## 切段規則

工具依排序後的有效點依序建立 segments。下列任一條件成立時，當前點成為
新的 `<trkseg>` 第一點：

- 這是第一個有效點。
- 排序序列中介於兩個有效點之間的圖片有可解析時間、但無有效 GPS。
- 與上一有效點的 Haversine 距離 `> --split-distance-m`。
- 與上一有效點的時間差 `> --split-time-sec`。

補充規則：

- 距離或時間剛好等於門檻時維持同一 segment。
- 不因距離為 `0` 而略過點；去重屬於其他既有工具的責任。
- 只含單一 track point 的 segment 仍應保留，因為該照片位置仍是有效資料。
- 若全部圖片均無有效 GPS 與時間，工具回傳非零 exit code，不建立 GPX。

## GPX 輸出格式

輸出維持目前 `gpx.fmt` 可被 GPX Editor 開啟的 GPX 1.0 結構；creator
改為工具名稱。所有文字欄位必須進行 XML escaping。

```xml
<?xml version="1.0" encoding="utf-8"?>
<gpx version="1.0"
 creator="jpg-to-gpx"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
 xmlns="http://www.topografix.com/GPX/1/0"
 xsi:schemaLocation="http://www.topografix.com/GPX/1/0 http://www.topografix.com/GPX/1/0/gpx.xsd">
 <trk>
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
Split: distance 3521.4 m > 200 m
  from: 2026-05-23T07-37-08+0800_f01170.jpg
  to:   2026-05-23T18-43-27+0800_f00165.jpg
```

下列狀況應以非零 exit code 結束：

- 輸入資料夾不存在或不可讀。
- 輸出路徑已存在且未提供 `--force`。
- 門檻或 timezone 參數格式不合法。
- 沒有找到 JPG。
- 沒有任何可輸出的有效 track point。
- 寫入 GPX 失敗。

單一圖片 metadata 無效屬於可恢復錯誤：略過、回報，但若仍有有效點就輸出
GPX。

## 實作約束

- 使用 CommonJS 與 Node.js，風格比照此 package 既有 scripts。
- 優先沿用目前相依套件 `piexifjs` 讀取 EXIF；不要求使用者安裝或呼叫外部
  `exiftool` 才能產生 GPX。
- Haversine 計算可沿用 `checkimg_speed_dupe.js` 中的距離公式。
- 僅以串流或逐張讀取所需 metadata 的方式處理；對數千張圖片不得保留 JPEG
  binary 內容於記憶體。
- 寫入時先建立完整內容至暫存檔，成功後再 rename 至輸出路徑，避免中途中斷
  留下不完整 GPX。

## 驗收條件

### 自動驗證

- 小型 fixture 含四張有效 GPS 照片，其中第 3 張距第 2 張超過 `200 m`：
  輸出應有兩個 `<trkseg>` 且四個 `<trkpt>`。
- 相鄰點距離低於門檻但時間相隔超過 `30 sec`：應切成兩個 segments。
- 照片時間有效但缺 GPS：該點略過，前後有效點不可落在同一 segment。
- 照片時間不可解析：該點略過且摘要明確警告其無法作為 segment boundary。
- `<time>` 應為 UTC，含 `+08:00` 的 `07:26:10` 應輸出為前一天
  `23:26:10Z`。
- 路徑或檔名含 XML 特殊字元時，GPX 仍能被 XML parser 解析。
- 未提供 `--force` 不可覆蓋已存在的 GPX。

### 實際資料驗證

以 `20260523/geocoded` 產生新的 `20260523-segmented.gpx`：

- 工具應報告實際輸入數、有效點數、略過數與 segment 數。
- 輸出應包含 `<time>` 值，GPX Editor 不再顯示 `no time values`。
- 任一同一 `<trkseg>` 內的相鄰點均不得超過設定的距離或時間門檻。
- 在 GPX Editor 開啟輸出後，不應再出現跨越不連續拍攝地點的長直線。

以 `20260524/geocoded` 重複相同測試，確認工具可處理較大的照片集合。

## 實作工作項目

1. 新增 `jpg_to_gpx.js` 與命令列參數解析。
2. 實作 JPG 掃描、EXIF GPS/時間解析及時間來源 fallback。
3. 實作排序、Haversine 距離計算與 segment 分割。
4. 實作安全 GPX 寫入與處理摘要。
5. 在 `package.json` 註冊 `jpg-to-gpx` bin。
6. 在 `README.md` 增加使用方式、切段門檻與建議 pipeline。
7. 建立 fixture/測試，並用 `20260523` 與 `20260524` 實際 GPX 進行人工檢視。
