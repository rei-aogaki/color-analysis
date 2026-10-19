# リポジトリ・公開構成

## 1. 現在と将来の構成

README、LICENSE、CONTRIBUTING、docs、src、tests、ビルド設定、scriptsに加え、SECURITY.mdと `.github/workflows/pages.yml` を作成済み。実際の構成・起動は[開発手順](../CONTRIBUTING.md)を参照。以下の細分化は当初の責務分割案であり、未使用のディレクトリは作らない。

```text
README.md                    利用者向け概要・使い方・公開URL
LICENSE                      MIT本文・Copyright (c) 2026 rei-aogaki（作成済み）
SECURITY.md                  脆弱性の報告方針
CONTRIBUTING.md              開発手順・検証方法・公開情報の基準
.gitignore                   ローカルデータ・成果物の除外
.github/workflows/           検証CIとPages公開（権限を分離）
docs/                        外部・内部・セキュリティ等の仕様
index.html                   アプリ入口・CSP等のmeta
package.json                 開発・ビルド・テストコマンド
package-lock.json            依存の固定（npm採用時）
tsconfig.json / vite.config.ts
src/
  main.ts                    初期化
  app/                       状態・ジョブ制御・ライフサイクル
  ui/                        選択・設定・表・グラフ・プレビュー
  image/                     形式検証・復号・画素取得
  analysis/                  完全一致・量子化・統計
  workers/                   集計・出力のWorker入口
  export/                    CSV/JSONシリアライズ
  types/                     共有データ契約
  styles/                    CSS・デザイントークン
tests/
  unit/                      集計・座標・形式検証・出力
  integration/               復号とCanvas・Worker
  e2e/                       操作・通信・ストレージ
  fixtures/                  自作の小さな合成画像・生成スクリプト
public/                      公開してよい固定資産だけ
dist/                        生成成果物（Gitへ追加しない）
```

UIと集計を分離し、将来Canvas取得処理を専用デコーダーに差し替える余地を持たせる。関数ごとに過度に細かいファイルへ分割せず、責務を説明できる単位にまとめる。

## 2. 開発・依存管理

実装済みコマンド：dev（開発サーバー）、typecheck、test、test:browser、build、preview。当初のtest:e2e案はtest:browserという名前で実装した。固定バージョンと手順はpackage.json・package-lock.json・CONTRIBUTINGへ記録した。

依存は最小限、バージョン固定、ロックファイルを追跡する。不要な解析SDK・外部サービス依存を入れない。ライセンスと脆弱性を確認し、開発用依存にも同じ基準を適用する。CIはlockから再現ビルドする。

## 3. Pages公開案

設定を実装済み。現行の公開契約は[公開手順](publishing.md)を優先する。通常ビルドは比較ページを含み、公開用の `build:pages` は本体のみ。履歴点検・検証の成功と `PAGES_ENABLED=true` を公開条件にする。GitHub側への設定反映と初回デプロイは未実施。

公開リポジトリからGitHub Actionsで静的ビルドし、distのみをPagesへ配信する。docs/は設計資料であり、Pagesの配信元として使わない。プロジェクトサイトのリポジトリ名を含むサブパスに対応するbaseを設定し、Workerやアセットにも適用する。URLは実際の公開完了後にREADMEへ記載する。

Workerは外部ファイルとしてビルドし、固定の同一オリジン資産として読み込む。ネットワーク検証に使う資産一覧もビルドから生成する案とする。GitHub Pagesのプロジェクト間では同じオリジンを共有する場合があるため、パスを認証やデータ隔離の境界とは考えず、このアプリはそもそも永続ストレージを使わない。ライセンス表示・依存に必要な通知は配信物にも含める。

アプリは単一ページとし、サーバー側ルーティングやSPAの深いパスを要求しない。公開資産は同一オリジン相対参照にする。外部CDNやフォントにアクセスしない。

CIでは型検査・集計テスト・ビルド・必要なブラウザテストを実施。通常のPRは検証のみ。公開は保護した既定ブランチへの反映後に限定し、pagesへの書き込みとIDトークン権限は公開ジョブだけに付与する。具体的なブランチ名やアカウントをこの文書に仮定しない。

公開前に配信資産の一覧を確認し、docs、テスト、実画像、ローカルファイル、秘密、不要なソースマップが混入していないことを検証する。必要なら以前の安全なコミットを再ビルドして戻せる手順を設ける。公開コード自体はGitHub上で閲覧可能である。

## 4. 公開禁止情報

個人名・メール・住所・端末名・ローカル絶対パス、APIキー・トークン・秘密鍵、実画像、個人を含むスクリーンショット、ログ、環境設定、ブラウザプロファイルを追加しない。ユーザーが公開用著作権者名として明示指定したrei-aogakiの表記は許可する。それ以外の例示は架空の固定文字列・コード生成画像だけを使う。

.gitignoreの候補：node_modules/、dist/、coverage/、test-results/、playwright-report/、.envと派生ファイル、*.log、local-data/、IDEの個人設定。除外は漏えい防止の補助であり、秘密をリポジトリの中に置く運用を正当化しない。

テスト画像はfixturesの許可された合成画像のみ追跡し、拡張子一律の画像除外はしない。コミット前にステージ差分を、公開前にGit履歴と成果物も確認する。D-10でMIT採用と著作権者名rei-aogakiが確定し、標準MIT本文のLICENSEを作成済み。READMEからLICENSEへ案内する。本名・メールを推測して記載せず、Gitの著者設定は別途確認する。アプリの正式な公開名はcolor-analysis。
