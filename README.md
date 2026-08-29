# 翻訳こんにゃく

ブラウザ会議の相手の音声と、自分のマイク音声を双方向に翻訳するWebアプリです。原文・翻訳文を表示し、翻訳結果を音声でも再生します。

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
OPENAI_API_KEY=sk-...
TRANSLATION_PROVIDER=openai
```

モデルを明示する場合は `.env.example` の項目も追加できます。OpenAI Platform側で月額上限とアラートを設定してください。

## Zoom / Meetへ翻訳音声を渡す

通常のWebページは、生成した音声を別タブの「マイク」に直接変換できません。WindowsにVB-CABLEなどを導入したうえで、次のように設定します。

1. 本アプリの「相手へ送る翻訳音声の出力先」で仮想ケーブルの入力側を選択
2. Zoom/Meetのマイク設定で仮想ケーブルの出力側を選択
3. 自分はヘッドホンを使用

## コマンド

```powershell
npm.cmd run dev
npm.cmd run check
npm.cmd test
npm.cmd run build
```

推定料金は送信した発話時間とテキストトークンから算出する参考値です。正式な請求額はOpenAI Platformで確認してください。
