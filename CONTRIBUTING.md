# 開発と検証

試作版をGitHub Pagesで公開済み。Pages公開設定・CIを用意し、mainへの更新で検証後に自動配信する。合成画像だけで開発・検証し、実ユーザーの画像や個人情報をコミットしない。[公開前点検](docs/release-review.md)と[公開手順](docs/publishing.md)を参照。

## 準備

Node.js 24.11以上とnpmを使用する。依存はpackage-lock.jsonで固定している。

```sh
npm ci
```

ブラウザへ配信するコードはフレームワーク・外部API・解析SDKを含まない。TypeScript・Vite・Playwrightは開発用依存。

## 起動

```sh
npm run dev
```

開発サーバーは127.0.0.1限定。Viteの更新機能はローカルWebSocketとスタイル挿入を使うため、開発モードではCSPのmetaを外す。送信・保存の検証にはこの開発モードを使わず、次の本番ビルドで確認する。

```sh
npm run build
npm run preview
```

本番ビルドは厳しいCSPを保持し、distへLICENSE.txt、Viteのヘルパー用THIRD_PARTY_NOTICES.txt、静的資産のasset-manifest.jsonを生成する。開発用ソースマップ・テスト・docsは配信しない。previewも127.0.0.1限定であり、外部公開ではない。

## テスト

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run test:design
npm run audit:source
npm run audit:history
npm run build:pages
npm run test:browser
npm run audit:dist
```

単体テストはNode.js標準のテストランナー、ブラウザ検証はPlaywrightを使用する。ブラウザ本体のダウンロードは開発時のみ必要。既存の互換ブラウザを使う場合はTEST_BROWSER_EXECUTABLEで実行ファイルを指定できるが、バージョンを結果に記録する。

ブラウザ検証はテスト専用の一時HTTPサーバーを127.0.0.1で起動し、`/color-analysis/`サブパスでビルド成果物を配信する。サーバーは検証後に終了する。外部サービスや実ユーザー画像へはアクセスしない。TEST_BASE_URLを指定すると既に起動している試作サーバーを使用できる。

検証出力はGit除外済みの.local/に置く：ブラウザレポートとPC／スマホ幅のスクリーンショット。スクリーンショットは自作サンプルのみ。これらを公開する場合も内容を確認する。

## 構成

| 場所 | 責務 |
|---|---|
| index.html / src/styles.css | 日本語画面・レスポンシブ表示 |
| design.html / src/design/ | 同じ画像と解析結果で比較するデザイン2案 |
| src/main.ts | ページ状態、画素検査、Worker管理、結果表示 |
| src/image/read.ts | 容量・形式・構造・寸法・向き・アニメ判定、復号・原寸画素取得 |
| src/analysis/histogram.ts | 完全一致・固定区間分類・ソート・ページ検索 |
| src/analysis/families.ts | OKLCHの色系統分類、固定の境界と版番号 |
| src/workers/analysis.worker.ts | メイン画面を占有しない集計・結果保持・出力 |
| src/export/serialize.ts | 固定スキーマの全件CSV・JSON、出力キャンセル |
| src/editor/ | 色もどし：モノクロ化・マスク合成（mask.ts）、Undo履歴（history.ts）、ブラシ形状（shapes.ts）、編集画面（editor.ts） |
| tests/fixtures/png.ts | コードで生成する合成PNG・EXIF |
| tests/unit/ / tests/browser/ | 数値・形式検証／実ブラウザの操作・通信・保存検証 |
| scripts/prepare-dist.mjs | 配信物のライセンス通知と資産一覧 |

技術詳細の型・関数名は実装を正とし、docsの内部仕様は設計上の契約として照合する。試作と設計の差分は[試作結果](docs/prototype-results.md)で管理する。

## 公開前

公開用ビルドは比較ページを含まない。通常ビルドの比較画面テストを先に行い、公開用へ再ビルドして本体を検証する。CIも同じ順序を使う。初回コミットのメールは、ユーザーの承認後に非公開用へ置換しGitHubへ反映済み。公開対象の履歴点検は成功したが、古いコミットへの直接参照は残るため、対応記録を確認する。Gitの識別情報は指定ハンドルとGitHubの非公開用メールを使い、履歴の修正には別途合意を得る。

既知の未検証事項を[検証基準](docs/verification.md)と[試作結果](docs/prototype-results.md)で確認する。実機確認・多色画像のメモリ実測・Git履歴の個人情報確認は、ローカルのテスト成功だけでは完了しない。依存更新時はロックファイル、条件・脆弱性情報、ビルド成果物を見直す。Git著者情報や過去履歴を自動で変更しない。
