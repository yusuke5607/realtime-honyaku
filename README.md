# リアルタイム会議通訳

ブラウザ会議の相手の音声と、自分のマイク音声を双方向に翻訳するWebアプリです。原文・翻訳文を表示し、翻訳結果を音声でも再生します。

> GitHubリポジトリをPublicにしても、アプリがWeb上で動くようになるわけではありません。別のPCではcloneしてローカル起動するか、Azureなどへデプロイする必要があります。

費用を抑えるため、発話区間だけを次の順で処理します。

- `gpt-transcribe`: 文字起こし
- `gpt-4o-mini`: テキスト翻訳
- `gpt-4o-mini-tts`: 翻訳文の音声合成

## 必要なもの

- Node.js 20以上
- OpenAI APIキー
- ChromeまたはEdge
- ヘッドホン（エコー防止のため推奨）
- 自分の翻訳音声をZoom/Meetへ渡す場合は、VB-CABLEなどの仮想オーディオデバイス

## 起動

```powershell
npm.cmd install
npm.cmd run dev
```

表示されたURL（通常は <http://localhost:5173>）を開きます。

1. 「会議タブを選んで開始」を押します。
2. Zoom/Meetのタブを選び、「タブの音声を共有」をオンにします。
3. マイク利用を許可します。
4. 相手向け音声の出力先を選びます。

## OpenAI APIキー

プロジェクトの1階層上に `.env` を置きます。APIキーはサーバーだけが読み、ブラウザには送りません。

```dotenv
OPENAI_API_KEY=your-openai-api-key
TRANSLATION_PROVIDER=openai
```

モデルを明示する場合は `.env.example` の項目も追加できます。OpenAI Platform側で月額上限とアラートを設定してください。

## 任意のPCでローカル実行する

Publicリポジトリから次のように取得して実行できます。

```powershell
git clone https://github.com/yusuke5607/realtime-honyaku.git
cd realtime-honyaku
npm.cmd install
npm.cmd run dev
```

実行するPCごとにOpenAI APIキーの設定が必要です。APIキーをリポジトリ、ソースコード、`VITE_*`環境変数へ書かないでください。

## Zoom / Meetへ翻訳音声を渡す

通常のWebページは、生成した音声を別タブの「マイク」に直接変換できません。WindowsにVB-CABLEなどを導入したうえで、次のように設定します。

1. 本アプリの「相手へ送る翻訳音声の出力先」で仮想ケーブルの入力側を選択
2. Zoom/Meetのマイク設定で仮想ケーブルの出力側を選択
3. 自分はヘッドホンを使用

## 公開デプロイ時の必須設定

```dotenv
NODE_ENV=production
TRANSLATION_PROVIDER=openai
OPENAI_API_KEY=your-openai-api-key
APP_ACCESS_TOKEN=十分に長いランダムな共有アクセスキー
ALLOWED_ORIGINS=https://your-app.example.com
HOST=0.0.0.0
MAX_CONCURRENT_SESSIONS=5
MAX_SESSION_AUDIO_SECONDS=3600
```

本番環境で`APP_ACCESS_TOKEN`がない場合、サーバーは安全のため起動しません。画面へ入力するアクセスキーはサービス利用者を制限するためのもので、OpenAI APIキーとは別物です。多人数へ提供する場合は、共有キーではなくMicrosoft Entra IDなどの利用者認証へ置き換えてください。

## コマンド

```powershell
npm.cmd run dev
npm.cmd run check
npm.cmd test
npm.cmd run build
```

推定料金は送信した発話時間とテキストトークンから算出する参考値です。正式な請求額はOpenAI Platformで確認してください。
