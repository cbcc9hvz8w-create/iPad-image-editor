# SnapCanvas

iPadで保存済み画像をすばやく整え、Goodnotesなどへ渡すための完全オフライン画像編集PWAです。画像処理はブラウザ内で完結し、画像をサーバーへ送信しません。

## iPadへのインストール

1. 公開したSnapCanvasのURLをiPadのSafariで開きます。
2. 共有ボタンを押します。
3. 「ホーム画面に追加」を選びます。
4. ホーム画面のSnapCanvasアイコンから起動します。

最初の1回はオンラインで開いてください。アプリ一式が端末へ保存された後は、通信がない状態でも画像編集を利用できます。

## GitHub Pagesへ手動公開する場合

`github-dist`フォルダの中身だけを、GitHubリポジトリのルートへアップロードします。GitHubで **Settings → Pages** を開き、次のように設定します。

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/(root)`

保存後、同じ画面に表示される **Visit site** からアプリを開けます。リポジトリ直下に`index.html`が見えていることを確認してください。

## GitHub Actionsで自動公開する場合

ソース一式をアップロードし、**Settings → Pages → Source** を`GitHub Actions`に設定します。`.github/workflows/pages.yml`が、mainブランチの更新ごとにiPad用PWAをビルドして公開します。

## ローカル開発

Node.js 22.13以降とpnpm 11.19以降を使用します。

```bash
corepack enable
pnpm install
pnpm dev
```

GitHub Pages用の静的ファイルを作る場合：

```bash
pnpm build:pages
```

生成先は`github-dist`です。

## 主な機能

- JPEG / PNG / WebP画像の読み込み
- 切り抜き、リサイズ、回転、反転、傾き補正
- 明るさ、コントラスト、彩度、シャープ、モノクロなどの調整
- PNG / JPEG書き出し、JPEG品質・目標容量の指定
- JPEGのEXIF情報を保持または削除
- 変更履歴、編集前後の比較、設定プリセット
- 複数画像への一括処理
- ホーム画面からの全画面起動とオフライン利用

## プライバシー

読み込んだ画像と編集処理は端末内で完結します。プリセット以外の画像データをアプリが永続保存することはありません。
