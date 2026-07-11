<div align="center">

# Velorn

**オープンソースの AI 動画ワークステーション ― あなたには本格的なエディターを、あなたのエージェントには 100 以上の MCP ツールを。**

[![Latest Release](https://img.shields.io/github/v/release/VelornLabs/velorn?label=Latest&color=6C63FF)](https://github.com/VelornLabs/velorn/releases/latest)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue)](../../LICENSE)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-444444)](https://github.com/VelornLabs/velorn/releases/latest)

[![Website](https://img.shields.io/badge/Website-velorn.ai-0A9396)](https://velorn.ai)
[![Follow on X](https://img.shields.io/badge/Follow-%40getvelorn-000000?logo=x&logoColor=white)](https://x.com/getvelorn)
[![Join our Discord](https://img.shields.io/badge/Discord-コミュニティに参加-5865F2?logo=discord&logoColor=white)](https://discord.gg/QWZUuUChVK)

[![Download for Windows](https://img.shields.io/badge/Windows-ダウンロード-0078D4?style=for-the-badge)](https://github.com/VelornLabs/velorn/releases/latest)
[![Download for macOS](https://img.shields.io/badge/macOS-ダウンロード-1a1a1a?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/VelornLabs/velorn/releases/latest)
[![Download for Linux](https://img.shields.io/badge/Linux-ダウンロード-E95420?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/VelornLabs/velorn/releases/latest)

[English](../../README.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md) · 日本語 · [한국어](README.ko.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md)

</div>

<p align="center"><img src="../readme/agent-editing.gif" alt="プロンプトひとつ：Claude が MCP 経由で Velorn の編集を構築" width="860"></p>
<p align="center"><i>プロンプトひとつ。エージェントがメディアを生成し、タイムラインを組み立て、音声をミックス — MCP 経由でライブに。</i></p>

> この翻訳はベストエフォートで維持されています。不明な点がある場合は、[英語版 README](../../README.md) が正となります。翻訳改善の PR を歓迎します！

Velorn は、ComfyUI を使うクリエイターのためのオープンソース・デスクトップ AI 動画ワークステーションです。企画、生成、アセット管理、タイムライン編集、字幕、エフェクト、書き出しを、プロジェクト単位のひとつのアプリにまとめています。

内蔵のローカル/クラウドワークフローを使う、自分の ComfyUI API ワークフロー JSON を持ち込む、または同梱の Velorn Bridge をインストールして ComfyUI で開いているグラフを Velorn に送り返す、といった使い方ができます。

<p align="center">
  <img src="../readme/editor-timeline.png" alt="生成アセット、プレビュー、タイムライントラック、インスペクターを表示した Velorn エディター" />
</p>

## Velorn の用途

- 歌詞、タイミング、キャラクター、キーフレーム、ビデオショット、タイムライン編集からミュージックビデオを制作。
- 編集可能なショットプランを備えた UGC 風クリエイター広告や中小ビジネス向け広告の制作。
- 厳選されたローカル/クラウドの画像・動画ワークフローをひとつの Generate ワークスペースから実行。
- カスタム ComfyUI の画像、動画、キーフレーム、ミュージックビデオワークフローをアプリ内で実行。
- 生成したクリップを、トラック、トランジション、エフェクト、字幕、プロキシ/キャッシュツール、書き出しで編集。
- 生成メディア、プロンプト、ワークフロー出力、タイムラインをプロジェクト内で整理。

Velorn は ComfyUI の代替ではありません。ComfyUI を取り巻くプロダクション層です。作業を計画し、ジョブを ComfyUI に送り、出力を集め、編集を仕上げます。

<p align="center">
  <img src="../readme/create-workflows.png" alt="UGC、ビジネス広告、ミュージックビデオ、短編映画のクリエイターを備えた Velorn Create ワークスペース" />
</p>

## ダウンロード

ほとんどのユーザーは、[GitHub Releases ページ](https://github.com/VelornLabs/velorn/releases)からパッケージ済みデスクトップアプリをダウンロードしてください。

リリースには以下のアセットが含まれます:

- `Windows Installer`
- `Windows Portable`
- `Mac (Apple Silicon)`
- `Mac (Intel)`
- `Linux AppImage`
- `Linux deb`

ソースからビルドする予定がない限り、GitHub が自動生成するソースコードアーカイブは無視してください。

## 主な機能

### Generate（生成）

Generate は、内蔵ローカルワークフロー、クラウド/パートナーワークフロー、カスタム ComfyUI ワークフローを実行します。

- ローカルの画像、動画、画像編集、オーディオ、ユーティリティワークフロー。
- Nano Banana 2、GPT Image 2、Seedance、Kling などのクラウドワークフローと、利用可能なパートナーノード経路。
- 自分の ComfyUI API グラフを Velorn で実行したいユーザー向けの Custom Image / Custom Video ワークフロー。
- ComfyUI から手動でワークフローを書き出したい上級ユーザー向けの API JSON インポート。
- 互換グラフを ComfyUI から Velorn の適切なパネルへ送れる Velorn Bridge 対応。
- 不足しているノード、モデル、認証情報、設定を検出するワークフローセットアップチェック。
- Local / Cloud フィルター付きの Featured / My Workflows / Templates ブラウザ。インポートしたコミュニティワークフローは、内蔵ワークフローと並んで Featured に表示されます。

<p align="center">
  <img src="../readme/generate-featured.png" alt="注目ワークフロー、Local/Cloud フィルター、依存関係チェッカーを備えた Velorn Generate ブラウザ" />
</p>

Templates タブでは、公式 ComfyUI テンプレートカタログ（サイズと人気情報付きの 500 以上のテンプレート）を閲覧し、任意のテンプレートを内蔵 ComfyUI タブで起動できます。

<p align="center">
  <img src="../readme/generate-templates.png" alt="カテゴリーとフィルター付きの公式 ComfyUI テンプレートカタログを表示する Velorn テンプレートブラウザ" />
</p>

### Create（制作）

Create には、Velorn の Director Mode エンジン上に構築されたガイド付きクリエイターワークフローが含まれます。

- **Music Video Creation** - 楽曲、歌詞タイミング、キャラクター、参照画像、演出スクリプトを、キーフレーム、ビデオショット、編集可能なタイムラインに変換します。
- **UGC Creator** - フック、セリフ、商品デモ、試着、体験談を備えたクリエイター風 SNS 広告を、ショット単位で編集可能な形で制作します。
- **Business Ad Creator** - 地域ビジネス、EC 商品、イベント、サービス、小規模チーム向けの、オファー第一の広告を制作します。
- **Short Film Creation** - 脚本からシーンカバレッジを作る実験的ワークフロー。まだベータ段階のため、粗い部分があるかもしれません。

### Music Video Creation（ミュージックビデオ制作）

ミュージックビデオクリエイターは以下に対応しています:

- 楽曲のインポートと歌詞タイミング。
- ASR 文字起こし、または貼り付けた歌詞の SRT への整列。
- 既存のキャラクターシートを含む、人物/キャストの設定。
- ショットごとのキーフレームプロンプト、参照画像、プロンプトのコピー・編集、画像差し替え、ショットの再実行。
- Qwen Image Edit や Nano Banana 2 などの内蔵キーフレーム経路。
- Velorn エンドポイントノードを使ったカスタムキーフレームワークフロー。
- LTX 2.3 Music や WAN 2.2 などの内蔵ビデオ経路。
- キーフレーム画像、プロンプト、シード、幅、高さ、FPS、長さ、オーディオを任意で注入できるカスタムビデオワークフロー。
- 生成されたショットアセットからのタイムライン組み立て。

### タイムラインエディター

エディターには以下が含まれます:

- プロジェクトアセットブラウザ。
- マルチトラックのビデオ/オーディオタイムライン。
- クリップのトリム、移動、スナップ、重なり時の置き換え動作、トランジション。
- テキスト、シェイプ、タイトル、単色、調整レイヤー、キーフレーム、ビジュアルエフェクトのツール。
- インスペクターコントロール。
- 再生を滑らかにするプロキシ/キャッシュツール。
- 最終レンダリング用の書き出しパネル。

### 字幕

字幕は編集済みタイムラインのオーディオから生成し、アプリ内でスタイルを設定できます。

- タイムラインを考慮した文字起こし。
- 字幕スタイルのプリセット。
- フォント、色、縁取り、背景、影、アニメーションのコントロール。
- 再利用できる字幕スタイルプリセットの保存。
- 再生/スクラブ操作とセーフゾーンオーバーレイ付きのライブプレビュー。
- 書き出しに対応した字幕レンダリング。

### 書き出し

Export タブには、実用的なレンダープリセット、利用可能な場合のハードウェアアクセラレーション、キュー管理、プロジェクトに応じた出力設定が含まれます。

<p align="center">
  <img src="../readme/export-settings.png" alt="プリセット、コーデック設定、書き出しキューを備えた Velorn の書き出し設定" />
</p>

### Stock（ストック素材）

Stock タブは Pexels を利用しており、写真や動画を検索して現在のプロジェクトに直接インポートできます。Pexels API キーは任意で、Settings から追加できます。

<p align="center">
  <img src="../readme/stock-pexels.png" alt="Pexels の写真・動画検索を備えた Velorn Stock タブ" />
</p>

### ComfyUI 連携

Velorn はローカルの ComfyUI サーバーと通信し、その起動を補助することもできます。

- デフォルトエンドポイント: `http://127.0.0.1:8188`
- Settings でのカスタムポート対応。
- 設定した ComfyUI 起動スクリプトの Windows ランチャー対応。
- 設定した `ComfyUI.app` の macOS ランチャー対応。
- 任意の自動起動、終了時停止、再起動の動作。
- グラフを開いて編集できる内蔵 ComfyUI タブ。
- 内蔵 ComfyUI タブでの ComfyUI アカウントログイン対応。
- 利用可能な場合の ComfyUI クレジット残高表示。

デスクトップアプリでは、localhost/ループバックの ComfyUI エンドポイントのみに対応しています。

### AI エージェント（MCP）

Velorn には、Codex、Claude Code、Cursor 互換ツール、その他の MCP クライアント向けに 100 以上のツールを備えたローカル MCP サーバーが含まれています。

- エンドポイント: `http://127.0.0.1:19790/mcp`
- アプリ内設定: `Settings > Agents (MCP)`（クライアントごとにコマンドをコピー＆ペーストするだけ）
- ガイド: [docs/MCP.md](../MCP.md)

エージェントは、開いているプロジェクトの確認、タイムラインのフレームや表示中ショットのレビュー、ComfyUI セットアップのトラブルシューティング、安全なタイムライン編集のプレビュー、承認済み生成ジョブのキュー投入、納品用書き出しの開始ができます。

エージェントはコミュニティの ComfyUI ワークフローを取り込むこともできます。ワークフローのリンクやファイルを渡すと、グラフを解析し、不足しているカスタムノードとモデルを報告し、承認後にインストールして、タイムラインのアセットでそのワークフローを実行します。

書き込み系ツールはまず実行プランをプレビューし、承認後にのみ適用され、すべて Velorn の通常のアンドゥスタックに載ります。MCP は、エージェント支援のレビュー、タイムライン操作、グラフィックの仕上げ、生成ワークフローに推奨される自動化経路です。

<p align="center">
  <img src="../readme/agents-mcp.png" alt="稼働中のローカルサーバー、接続コマンド、全ツールリストを表示する Velorn Agents (MCP) 設定" />
</p>

## カスタムワークフロー

カスタムワークフローは、Velorn が存在する主な理由のひとつです。

上級ユーザーは次のことができます:

1. Velorn からスターターグラフを開く。
2. ComfyUI でそれを編集する。
3. 必要な Velorn エンドポイントノードを維持する。
4. Velorn Bridge で送り返すか、API ワークフロー JSON を手動でインポートする。
5. そのグラフを、クリエイターフローの一部として、または Generate から Velorn で実行する。

よく使う Velorn エンドポイントノードのタイトル:

- Velorn input image - `VELORN_INPUT_IMAGE`
- Velorn prompt - `VELORN_PROMPT`
- Velorn seed - `VELORN_SEED`
- Velorn width - `VELORN_WIDTH`
- Velorn height - `VELORN_HEIGHT`
- Velorn FPS - `VELORN_FPS`
- Velorn duration - `VELORN_DURATION`
- Velorn audio - `VELORN_AUDIO`
- Velorn output image - `VELORN_OUTPUT_IMAGE`
- Velorn output video - `VELORN_OUTPUT_VIDEO`

正確な `VELORN_*` タイトルが推奨されますが、`Velorn input image` のような読みやすいタイトルも認識されます。古い `COMFYSTUDIO_*` マーカータイトルを使うグラフも後方互換のためサポートされています。

エンドポイントが存在すれば、Velorn はその値を注入できます。存在しなければ、その設定はグラフ側で制御されます。

<p align="center">
  <img src="../readme/comfyui-bridge.png" alt="Velorn エンドポイントノードと Send to Velorn ボタンを備えた内蔵 ComfyUI グラフ" />
</p>
