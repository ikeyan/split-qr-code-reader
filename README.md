# つなぐ QR

複数の QR Code Structured Append と通常の QR を画像やカメラから読み取り、端末内で組み立てる静的サイトです。カメラ映像上の QR に指を置くと採択し、指を置いたまま別の QR に移して連続して読み取れます。

仕様は [spec/仕様.md](spec/仕様.md) を参照してください。読み取りと組み立ての処理は端末内で行い、ページ読み込み後にアプリが通信することはありません。QR デコーダーの WebAssembly は JavaScript に同梱します。

## 開発

Deno 2.9.8 を使用します。

```sh
deno task build
deno task check
deno task test
deno run --allow-net --allow-read jsr:@std/http/file-server dist
```

`src/index.html` をエントリーポイントに `deno bundle` で `dist/` に出力します。カメラは HTTPS または localhost で利用できます。GitHub Actions は main への push 後にビルドとテストを行い、GitHub Pages に公開します。

QR デコードに [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) を使用しています。同梱ライセンスは `vendor/zxing-wasm-LICENSE.txt` です。
