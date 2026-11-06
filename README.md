# 2chmm要約リーダー（スタンドアロン版）

Muse アプリを開かなくても、iPhone のホーム画面アイコン／ショートカットから直接開ける、GitHub Pages 版のリーダーです。
仕組みは「おむつミルログ」と同じで、静的サイトとして公開し、データは GitHub Actions が定期的に自動更新します。

## セットアップ手順

1. **GitHub に新しいリポジトリを作る**
   - 例: `2chmm-reader`（Public / Private どちらでも Pages が使えるプランなら可）
2. **このフォルダの中身をそのままアップロード（push）する**
   - `index.html` / `sw.js` / `manifest.webmanifest` / `icon.svg` / `scripts/` / `data/` / `.github/` をすべて含める
   - ※ `.github` フォルダは隠しフォルダなので、ウェブ画面からのアップロード時は取りこぼしに注意（git push 推奨）
3. **GitHub Pages を有効化**
   - リポジトリの Settings → Pages → Build and deployment → Source: `Deploy from a branch`
   - Branch: `main` / フォルダ: `/ (root)` を選んで Save
   - 数分で `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開される
4. **iPhone で開いてホーム画面に追加**
   - Safari で公開URLを開く
   - 共有ボタン →「ホーム画面に追加」
   - 以後はアイコンからアプリのように起動できる（ショートカットアプリの「URLを開く」でも可）

## データの更新

- `.github/workflows/update.yml` が **毎時0分** に `scripts/fetch.mjs` を実行し、`data/` を自動コミットします（Actions タブから手動実行も可）
- 更新内容: 2chmm の新着、おばにゅー（直近14日分）、各ブログの過去記事（フィードから拡充）、本文・コメント
- 本文は1回の更新で新規150件まで取得し、過去に取得した本文は保持されるので、回を重ねるごとに読める記事が増えます
- アプリ側は開くたびに最新の一覧データを取り直します（本文はキャッシュ優先で高速表示）

## Muse 版との違い

- **要約機能はありません**（要約には AI のバックエンドが必要なため、この版ではボタンを付けていません）
- データはリアルタイムではなく、Actions のスケジュール（約1時間ごと）で更新されます
- コメント・本文は取得時点の内容です（Muse 版のような開くたびの再取得はしません）

## データ形式（開発者向け）

- `data/index.json`
  ```json
  {
    "generatedAt": "ISO日時",
    "blogs": [{ "key": "ブログID", "name": "ブログ名", "url": "ブログURL", "category": "news|game|entertainment|animal|other", "pinned": true/false }],
    "articles": [{ "id": "記事ID(URLのSHA-256先頭12桁)", "blogKey": "ブログID", "title": "タイトル", "url": "元記事URL", "publishedAt": 1234567890000, "hasBody": true/false }]
  }
  ```
  - `publishedAt` は元ブログ側の公開時刻（ミリ秒）。取れなかった記事は `null` で、一覧では時刻を表示しません
- `data/articles/<id>.json`
  ```json
  {
    "id": "記事ID",
    "publishedAt": 1234567890000,
    "posts": [ [ {"text": "本文", "color": "#e30000", "size": 25, "bold": true, "href": "リンク先"}, {"img": "画像URL"}, {"br": 1} ] ],
    "comments": ["コメント本文だけの文字列", "..."]
  }
  ```
  - `posts` は書き込み単位の配列。本文中の番号・名前・日時・ID などのヘッダーは除去済み
  - `comments` は元ブログの読者コメントの本文のみ（名前・日時・番号は含まない）。上限300件

## ローカルで取得スクリプトだけ動かす場合

```bash
node scripts/fetch.mjs   # Node 20+、依存ライブラリなし
```
