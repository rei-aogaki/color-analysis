# 内部仕様

本書は実装前の設計提案。公開する測定基準は「ブラウザ復号後のsRGB・8bit RGBA」。ファイル内サンプル値の検証器とは区別する。

0.2.0の更新：色系統別のfamiliesモード、各画素のUint8分類ラベル転送、表示専用ImageDataによる強調表示、schemaVersion=2を追加した。以下の型例は当初の設計モデルであり、現行の型・出力契約はsrc/types.tsおよび[色系統別集計](color-families.md)を参照する。

## 1. 技術と責務

A案へのUI統合では `index.html`、`src/styles.css`、`src/main.ts` の表示層を更新した。主要色表示はWorkerの件数順の先頭データを使用し、新しい近似集計は追加しない。折りたたみの状態はDOM内だけで扱い、クリア・画像変更で初期化する。解析・分類・復号・出力モジュールとschemaVersion=2は維持する。[統合の記録](design-integration.md)

TypeScript＋Vite、初期版はUIフレームワークなしという基本構成はD-07で確定。HTML/CSS、Canvas 2D、Web Workerを使う詳細設計とし、グラフライブラリも初期版では導入しない案。静的ファイルのみを配信し、バックエンド・DB・APIキーは設けない。開発・ビルド依存も固定し、ブラウザ実行時は同梱資産だけを読む。具体的なバージョンと追加依存は実装時に確認・記録する。

UI → 入力検証 → 画像復号 → 原寸Canvas → RGBAバッファ → 集計Worker → 結果モデル → テーブル／グラフ／エクスポート、の順で処理する。プレビューは別Canvasとし、解析バッファを表示倍率で変更しない。

ヘッダー読み取りで形式・寸法・向き・アニメ有無を検証してから復号する。読み取り範囲とチャンク数に上限を設け、オーバーフロー・範囲外参照を拒否する。外部参照を持つSVG等は復号対象にしない。

## 2. データ契約（主要型）

```ts
type Mode = 'families' | 'exact' | 'quantized';
type AlphaPolicy = 'exclude-zero' | 'all';
type Match = 'rgba' | 'rgb';
type AnalysisOptions =
  | { mode: 'families'; alphaPolicy: AlphaPolicy }
  | { mode: 'exact'; alphaPolicy: AlphaPolicy; match: Match }
  | { mode: 'quantized'; alphaPolicy: AlphaPolicy; step: 16 | 32 };
type RGBA = readonly [number, number, number, number];
type ColorRow = {
  key: number; rgb: readonly [number, number, number];
  alpha: number | null; count: number; ratio: number;
  family?: string;
}; // alpha=null: RGB一致または類似色。代表色は不透明の色見本
type AnalysisResult = {
  schemaVersion: 2; appVersion: string;
  classification?: {
    version: string; neutralChroma: number; blackLightness: number;
    whiteLightness: number; hueBoundaries: readonly number[];
  };
  measurementBasis: 'canvas-srgb-rgba8';
  width: number; height: number; options: AnalysisOptions;
  totalPixels: number; includedPixels: number; excludedPixels: number;
  transparentPixels: number; translucentPixels: number; opaquePixels: number;
  rows: ColorRow[];
};
type AppError = { code: string; message: string; recoverable: boolean };
type ResultSummary = Omit<AnalysisResult, 'rows'> & { rowCount: number };
type ResultHandle = { sourceId: number; jobId: number; summary: ResultSummary };
```

AnalysisResultはJSON出力・テスト用の論理モデルであり、全rowsをメインスレッドへ常時複製する契約ではない。UIはResultHandleと現在ページ分のColorRow[]を持つ。任意の「不透明のみ」条件は将来候補であり、初期版推奨型から除外した。

寸法・件数・keyは非負の安全な整数。RGB/alphaは整数0〜255、ratioは0〜1。境界で検証し、NaN/Infinity・型外値を拒否。modeごとに不要な設定を許可しない。ランタイム検証はTypeScript型と別に必要。

## 3. 関数の入出力

| 関数 | 入力 → 出力 | 責務・失敗 |
|---|---|---|
| validateFile | File → Promise<ValidatedImage> | 形式・サイズ・ヘッダー検証。内容をログに出さない |
| decodeImage | ValidatedImage → Promise<DecodedImage> | 向き補正したbitmapと寸法。失敗時解放 |
| readPixels | DecodedImage → PixelBuffer | 原寸sRGB RGBA8、length=width×height×4を検証 |
| inspectPixel | PixelBuffer, x, y → RGBA | 範囲チェック、offset=(y×width+x)×4 |
| analyze | PixelBuffer, options → Promise<ResultHandle> | Workerを起動し全画素を処理、完了後は概要と参照を返す |
| queryRows | ResultHandle, query → Promise<RowPage> | 検索・並び替え・ページ取得。全件の複製を避ける |
| exactHistogram | Uint8ClampedArray, options → Histogram | 表示系から独立した純粋な集計 |
| quantizeHistogram | Uint8ClampedArray, options → Histogram | 区間ごとの件数・RGB合計を整数で保持 |
| finalizeResult | Histogram, metadata → AnalysisResult | 割合・代表値・安定順序を生成 |
| serializeCsv / serializeJson | 結果メタデータと全行イテレーター → Blob | Worker内で全件出力。固定スキーマ、名前等を混入させない |
| clearSession | AppState → 初期状態 | Worker終了・URL破棄・参照解除 |

ValidatedImageはfile、形式、寸法、orientation、静止判定を持つメモリ内オブジェクト。DecodedImageは閉じられるbitmapと向き補正後寸法。PixelBufferはwidth、height、dataを持つ。Histogramは数値キーと整数件数／成分合計、および透明度別件数を保持する。公開されたファイルパスを保持する型は設けない。

queryは検索HEX（未指定可）、sort（count-desc/color-asc）、page（0始まり）、pageSize（50/100/200）を持ち、RowPageは一致総行数とページ分rowsを返す。無効な値はエラー。範囲外ページは最終有効ページに補正し、0件ならpage=0とする。

入力パーサーの推奨境界：容量上限以内のファイルを最大64KiBずつ読み、総読み取り量・走査オフセットをファイル長以内に保つ。PNGのチャンク・JPEGのマーカー／EXIF・WebPのRIFF構造の長さと終端を検証し、PNGのacTLとWebPのアニメーション指定・フレームチャンクを検出して拒否する。寸法・向きの検証後にのみ復号する。色空間等のデータを元Fileから解析結果へコピーしない。偽装された寸法・範囲外EXIF・不正な構造は推測で処理せずエラーにする。初期版の追加ガードとして構造要素10万件を暫定上限とし、正当なファイルも制限対象になり得る旨をエラーで示す。この値はレビュー推奨値で、実測対象とする。

## 4. 復号・画素取得

Canvasは解析元のwidth/heightを設定し、CSSの表示寸法・devicePixelRatioを解析寸法に掛けない。2D contextにsRGBを指定し、全領域へ一度描画、getImageDataで8bit RGBAを取得。想定する色空間・配列型を利用できない環境は、暗黙の精度低下をせず非対応として扱う。

EXIF向きの二重補正を避ける。復号APIが補正済みかをテスト画像で確認し、アダプターを一本化する。Canvasのアルファ処理に伴う丸め、ICC変換、JPEG非可逆圧縮、16bit入力の8bit化は復元できない。画素値の読み取りや色管理のブラウザ差を結果説明から隠さない。[Canvas標準](https://html.spec.whatwg.org/multipage/canvas.html#pixel-manipulation)、[MDNの色空間説明](https://developer.mozilla.org/en-US/docs/Web/API/ImageData/colorSpace)

復号後にも実際の寸法が検証済み寸法（向き反映後）と一致し、各上限以内か確認してからCanvas領域を割り当てる。EXIFは回転だけでなく反転を含む1〜8を検証する。createImageBitmapのimageOrientation等をアダプターで固定し、PNG/WebPの向き情報も存在する場合に同じ基準で扱う。対応ブラウザで挙動を確認できない場合は、そのケースを検証未完了として公開判定へ回す。[復号オプション](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap)

## 5. 集計

完全一致：RGBAキーは`r*16777216 + g*65536 + b*256 + a`、RGBキーは`r*65536 + g*256 + b`。JavaScriptの符号付きビット演算に依存しない。透明度別件数を全画素で数えた後、対象条件を適用しキーごとの件数を加算。計算量O(N)、ヒストグラム領域O(U)。Uは異なる色数で、写真ではNに近づく可能性がある。

類似色：step=s、q=256/sとし、`key=floor(r/s)*q*q + floor(g/s)*q + floor(b/s)`。各グループのcount、sumR/G/Bを保持。代表成分は`floor(sum/count + 0.5)`。alphaを平均しない。全画素を処理し、最大グループ数はstep32で512、step16で4096。所属は元の区間キーで決め、代表RGBから再分類しない。

共通：N>0の場合のみratio=count/N。件数合計=N、対象数+除外数=全画素数、透明度別3件数合計=全画素数を検証。既定の並びはcount降順・key昇順。丸めは画面のパーセント表示時だけ行う。CSV/JSONのratioはcount/Nの有限精度値をそのまま数値文字列にし、画面用の丸めを適用しない。元件数を変えない。

CSV列はschemaVersion,appVersion,measurementBasis,width,height,mode,alphaPolicy,match,step,totalPixels,includedPixels,excludedPixels,transparentPixels,translucentPixels,opaquePixels,key,hex,r,g,b,alpha,count,ratio。modeに無関係な列とalpha=nullは空欄。UTF-8 BOM付き、CRLF、標準の引用符エスケープを用いる。自由入力文字列は出力せず数式注入を避ける。JSONは上記型をそのまま使用し、余分なメタデータを追加しない。

## 6. 非同期・状態管理

画像選択時から増分sourceIdを発行し、検証・復号の非同期完了にも照合する。画像変更・クリアは旧sourceIdを無効化する。解析には増分jobId、表の問合せと出力準備にはrequestIdを併用する。遅れて届く旧応答は採用せず、そのbitmapやBlob等を解放する。入力・応答の構造も検証する。

Worker要求はstart(sourceId,jobId,buffer,options)、queryRows(jobId,requestId,query)、prepareExport(jobId,requestId,format)、cancelExport(jobId,requestId)。応答はprogress、complete(summary)、rowsPage、exportReady(blob)、error。各応答へ対応するIDを付ける。解析進捗は走査画素数で示し、復号・ソート・出力は別フェーズ表示として偽の100%を出さない。

解析キャンセルはWorker.terminateで中間結果を破棄し、メイン側の画像・設定を残す。再解析は新Workerで実行する。初期案では画素検査用の原本バッファをメインに保持し、一つだけコピーをWorkerへtransferする。メイン原本のdetachを防ぐ。解析完了後はWorker側の画素コピーを解放し、集計と索引のみを保持したWorkerを結果破棄まで維持する。設定変更・再解析・差し替え・クリアは旧結果Workerを終了する。

ヒストグラム・ソート・検索・シリアライズはWorkerが担当し、UIには概要・上位グラフ分・現在ページ分だけを送る。全件をJSオブジェクト配列として複製する設計は避け、整数のキー／件数配列と並び順索引を候補に実測する。暫定で異なる色が100万を超えたら中断し、色数上限の理由を表示する。この上限は未承認のレビュー提案であり、D-04の画像上限とは区別する。到達を成功扱いせず、切り捨て・自動減色・サンプリングをしない。

出力は全行イテレーターから分割してBlobを準備し、巨大な中間JSON文字列や全件コピーを避ける。Workerはチャンクの間でイベントループへ制御を戻し、出力キャンセルは集計結果を保持したまま部分Blobを破棄する。Worker異常終了では解析結果を無効化して再解析を案内する。準備完了後はメイン側の明示クリックでdownloadリンクを使う。同時準備は1件。Blobは端末メモリ内でも負荷があるため、出力上限は性能試作で確認する。

## 7. リソースと異常処理

1600万画素のRGBAバッファ1本は約64MB（10進）。複製、bitmap、Canvas、ヒストグラム、ソート、出力Blobでさらに増えるため、64MBで動くとは説明しない。ファイル・寸法・異なる色数の上限を独立に管理する。端末の空きメモリを正確に検出できる前提を置かない。

入力失敗・差し替え・クリアはbitmap.close、Object URLのrevoke、Worker終了、Canvas寸法リセット、結果・File参照解除を行う。解析失敗・キャンセルはWorkerと中間結果だけ破棄し、検査元の画像・設定を保持する。出力失敗・キャンセルは出力用の一時データだけを解放し、集計結果を保持する。解放対象と保持対象をfinally相当の処理で混同しない。

ダウンロード用URLは次の準備・結果無効化・クリア・離脱時に破棄し、クリック直後に無条件revokeしない。pagehideを受信したら初期化し、pageshow.persistedでも表示前に初期化する。タブ切替・画面回転・ファイル選択画面への一時移動は終了扱いにせず、visibilitychangeだけで画像を消さない。pagehideはモバイルで必ず発火するものではないため、処理の基盤は「永続保存しない」こととし、イベントだけで完全消去を保証しない。[pagehideの制約](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event)

復号・Canvas読出しはメイン側で一時的に処理を占有する可能性がある。キャンセル250msの目標はWorker走査・チャンク化した出力処理の操作応答を対象とし、全フェーズで保証しない。読み込みにも状態表示とキャンセルを用意し、キャンセル後に完了した復号結果は採用しない。Worker側の復号・OffscreenCanvas利用は互換性試作で検討し、必須条件にはしない。
