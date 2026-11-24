# つなぐ QR

複数の QR Code Structured Append と通常の QR を画像やカメラから読み取り、端末内で組み立てる静的サイトです。カメラ映像上の QR に指を置くと採択し、指を置いたまま別の QR に移して連続して読み取れます。

別の Web ページの QR 画像もドラッグ＆ドロップできます。Web 画像はブラウザーで取得を試し、CORS などで取得できない場合は、設定済みの Cloudflare Worker に画像 URL を渡します。QR の読み取りと組み立ては端末内で行います。QR デコーダーの WebAssembly は JavaScript に同梱します。

仕様は [spec/仕様.md](spec/仕様.md)、読み取り手法の検討は [docs/読み取りロバスト化の調査.md](docs/読み取りロバスト化の調査.md) を参照してください。

## 開発

Deno 2.9.8 を使用します。

```sh
deno task build
deno task check
deno task test
deno task verify-png /tmp/確認する画像.png
deno run --allow-net --allow-read jsr:@std/http/file-server dist
```

`src/index.html` をエントリーポイントに `deno bundle` で `dist/` に出力します。カメラは HTTPS または localhost で利用できます。GitHub Actions は main への push 後にビルドとテストを行い、GitHub Pages に公開します。

ページのフッターにビルド元のコミットハッシュを表示します。カメラ画面の録画ボタンでは、音声なしで映像を保存できます。録画停止・カメラ終了時にWebMまたはMP4をダウンロードし、ファイル名にコミットの短縮ハッシュと端末の日時を付けます。録画データは端末内で処理します。カメラの「解析を重ねる」をオンにすると、候補枠、マーカー、曲面格子、標本化画像、復号結果を解析したフレームに重ねます。対応ブラウザーでは、オンにした状態で録画を始めると注釈入りの動画を保存できます。

「読み取り方法の違い」を開くと、読み取り方法と曲面推定の選択がそれぞれどこに効くかを図で確認できます。

カメラの復号はページ読み込み時に用意する専用Workerで実行します。通常の補正をフレームごとに試し、最近の探索領域と成功した格子補正を次のフレームへ引き継ぎます。結果は毎回そのフレームの画素から復号し直します。対応機器では1920×1080、連続フォーカス・露出を要求します。

曲面と照明むらの回帰テストは `deno test --allow-read tests/curved_paper_test.ts` で実行できます。QR を3D円筒面に投影して生成し、開発用と別シードの評価用それぞれで、元バイト列・分割情報が完全一致する読み取り率90%以上を要求します。実写真を確認するときはリポジトリ外に置き、`verify-png` にパスを渡してください。実写真はテストデータに含めません。

### Cloudflare Worker の画像プロキシ

1. `wrangler.toml` の `ALLOWED_ORIGIN` にリーダーを公開するオリジンを設定します。既定値は `https://ikeyan.github.io` です。
2. Cloudflare にログインした状態で `npx wrangler deploy` を実行します。
3. GitHub リポジトリの Actions リポジトリ変数 `IMAGE_PROXY_URL` に、デプロイ先の完全な URL（例 `https://split-qr-code-reader.<subdomain>.workers.dev/image`）を設定し、Pages のワークフローを実行します。ローカルや手動でビルドする場合は環境変数 `IMAGE_PROXY_URL` を設定して `deno task build` を実行します。

ローカルでは、次のコマンドで Worker を起動します。

```sh
npx wrangler dev --var ALLOWED_ORIGIN:http://localhost:8000
```

別のターミナルでサイトを起動し、`http://localhost:8000` から試せます。

```sh
IMAGE_PROXY_URL=http://localhost:8787/image deno task build
deno run --allow-net --allow-read jsr:@std/http/file-server dist
```

Worker は公開 HTTP(S) 上のラスター画像を最大 10 MiB まで取得します。画像の取得に失敗した場合は、元のページで画像をコピーしてリーダーに貼り付けられます。

QR デコードに [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) を使用しています。同梱ライセンスは `vendor/zxing-wasm-LICENSE.txt` です。

HEIC/HEIF の変換には [heic-to 1.6.7](https://github.com/hoppergee/heic-to/tree/v1.6.7)（LGPL-3.0 以降）を使用しています。配布する変換器は置き換え可能な `heic-to.js` として同梱し、ライセンスを `vendor/heic-to-LICENSE.txt` に収めています。対応するソースは [npm パッケージ](https://registry.npmjs.org/heic-to/-/heic-to-1.6.7.tgz) に含まれます。
