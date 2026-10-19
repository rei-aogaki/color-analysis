# GitHub Pagesの公開・更新手順

状態：設定ファイルを作成・ローカル検証済み。ソース・仕様・ワークフローはGitHubへ反映済み。Ubuntu runnerでの[初回Actions検証](https://github.com/rei-aogaki/color-analysis/actions/runs/39194381609)は成功し、公開ジョブはスキップされた。Pagesの有効化、デプロイ、公開URLの疎通確認は未実施。通常履歴のメールは修正済みで、古い参照が残る点をユーザーが承知して進める方針とした。[対応記録](email-privacy.md)を参照。[点検結果](release-review.md)

## 1. 公開の仕組み

`.github/workflows/pages.yml` が `main` へのpush、`main` 宛てのPR、手動実行を扱う。PRは検証のみ。公開は `main` から、リポジトリ変数 `PAGES_ENABLED` が文字列 `true` の場合だけ行う。変数を作らない間も検証は動く。手動実行でも別ブランチからは公開しない。

検証ジョブは依存インストール、ソース点検、依存脆弱性チェック、単体テスト、比較画面の検証、公開用ビルド、本体のブラウザ検証、配信物の点検を行う。履歴点検は全履歴を取得する別ジョブ。両方が成功した場合だけ公開ジョブへ進む。検証失敗時は古い公開サイトを置き換えない。

Actionsは公式リポジトリのリリースを確認して40桁のコミットSHAで固定した。Node.jsは24.11.1、runnerはubuntu-24.04。権限は通常 `contents: read` のみ。公開ジョブだけ `pages: write` と `id-token: write` を与える。checkoutでGitの資格情報を保持せず、PRで公開権限を与える `pull_request_target` は使わない。個別のAPIキーや個人アクセストークンは不要。

## 2. 公開物

```sh
npm ci
npm run audit:source
npm run audit:history
npm test
npm run build:pages
npm run test:browser
npm run audit:dist
```

ブラウザ本体は開発環境で `npx playwright install chromium`、Linux CIでは `npx --no-install playwright install --with-deps chromium` で用意する。

配信対象は `dist/` のアプリ入口、ビルド済みJS/CSSとWorker、LICENSE.txt、THIRD_PARTY_NOTICES.txt、asset-manifest.jsonのみ。比較用 `design.html` とその専用資産、docs、ソース、テスト、画像、ログ、環境ファイル、ソースマップは配信しない。相対参照で `/color-analysis/` のサブパスにも対応する。

ローカルで比較ページも確認したい場合は `npm run build` を使用する。`npm run build:pages` はdistを公開用に作り直すため、両者の成果物を混ぜない。CIは比較画面を検証した後、公開用に再ビルドして本体を検証する。ビルド済みdistはGitへ追加しない。

## 3. 初回の有効化

1. 履歴点検の指摘を解消し、今後のGit著者情報も公開用ハンドルとGitHubの非公開用メールに設定する。既存の公開履歴の変更には別途合意が必要。通常の新規コミットだけでは過去のメールは消えない。
2. 意図したソースだけをコミットし、GitHubへ反映する。初回は `PAGES_ENABLED` を設定せず、検証結果を確認する。
3. リポジトリの Settings → Pages → Build and deployment → Source を **GitHub Actions** に設定する。
4. Securityの非公開脆弱性報告を有効にし、SECURITY.mdの報告導線が実際に利用できることを確認する。
5. `main` の保護ルールで検証・履歴点検を必須にし、`github-pages` 環境の配信元を `main` に制限する。GitHub側の保護ルールはローカルのYAMLだけでは設定されない。
6. Settings → Secrets and variables → Actions → Variables に `PAGES_ENABLED=true` を設定し、Actionsの「Verify and publish Pages」を `main` から手動実行する。
7. 実行結果の公開URL、HTTPS、Worker、画像読み込み、色の選択、CSV/JSON保存を確認する。成功後に初めてREADMEへ実際の公開URLを記載する。

上の画面名やサービス仕様は変更される場合があるため、設定時には[GitHub公式の公開手順](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)も確認する。公開履歴に既に含まれた情報は、履歴を書き換えても他の人の複製やキャッシュまで完全に回収できるとは限らない。[GitHubの履歴からの機微情報削除](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)

## 4. 更新・停止・差し戻し

更新はPRで検証し、確認後にmainへ反映する。有効化後はmainへのpushごとに再検証・公開する。Actions自体や依存を更新する場合も、固定SHA・ロック・通知・ブラウザ検証を見直す。

新たな公開処理を止めるには `PAGES_ENABLED` を削除または `false` にする。すでに配信中のサイトはこれだけでは消えない。配信自体を止める場合はSettings → Pagesの公開停止を使用する。安全だった変更へ戻す場合はソースをrevertし、通常の検証・ビルド・公開をやり直す。既存Git履歴を上書きする方法を通常の差し戻しには使わない。
