# 翻訳こんにゃく

マイク音声をリアルタイムで翻訳するWebアプリです。次の2方式を画面から切り替えて比較できます。

- **分離型**: `gpt-live-transcribe`で文字起こしし、`gpt-5-mini`で翻訳
- **一括型**: `gpt-realtime-translate`で音声を直接翻訳

画面には原文、翻訳文、音声時間、初回結果までの時間、API使用量に基づく推定料金を表示します。一括型では翻訳音声も再生します。

## 必要なもの

- Node.js 20以上
- OpenAI APIキー（デモモードでは不要）
- マイクを利用できるChrome、Edgeなどのブラウザ

## 起動

```powershell
npm.cmd install
npm.cmd run dev
```

ブラウザで <http://localhost:5173> を開きます。初期状態はAPI課金が発生しないデモモードです。開始後しばらく話すと、固定のサンプル翻訳が表示されます。

## OpenAI APIを使う

APIキーをプロジェクト内へ置かないよう、プロジェクトの1階層上に`.env`を作成します。

```text
C:\Users\81902\Desktop\.env
```

内容は次のようにします。

```dotenv
OPENAI_API_KEY=sk-...
TRANSLATION_PROVIDER=openai
```

変更後、開発サーバーを再起動してください。APIキーはサーバーだけが読み取り、ブラウザへは送信しません。`.env`はプロジェクトの外にあるため、このリポジトリのGit管理対象にはなりません。既にプロセス環境変数が設定されている場合は、そちらが優先されます。

OpenAI APIの利用料金はChatGPTの契約とは別です。OpenAI Platform側で月額上限とアラートを設定してください。

## コマンド

```powershell
npm.cmd run dev      # 画面とサーバーを開発モードで起動
npm.cmd run check    # TypeScript型検査
npm.cmd test         # 単体テスト
npm.cmd run build    # 本番用画面をdistへ出力
npm.cmd start        # APIサーバーを起動
```

## 構成

```text
src/                 React画面、マイク録音、音声再生
server/              Fastify、WebSocket、OpenAI接続、料金計算
shared/protocol.ts   クライアント・サーバー共通の通信型
```

## 注意事項

- マイク音声は24 kHz、モノラル、PCM16として送信します。
- 推定料金はAPI応答の使用量と送信音声時間から算出した参考値です。正式な請求額はOpenAI Platformで確認してください。
- モデルやRealtime APIのイベント仕様が更新された場合は、`.env`のモデル名または`server/openai-realtime.ts`のアダプターだけを更新できる設計です。
