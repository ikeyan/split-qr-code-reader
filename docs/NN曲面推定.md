# WebGPUによる位置検出と曲面推定

読み取り方法が「自動」「曲面補正」のとき、WebGPUが利用可能なら小型NNによる経路を先に試す。通常画面とカメラの「曲面補正の方式」で「従来のみ」「マーカーNN・従来曲面」「マーカーNN・曲面NN」を切り替えられる。

NNは各マーカーの周辺を個別に処理する。全画像にマーカーが3個しかないとは仮定しない。黒い連結領域と既存検出器の候補を評価し、複数の3個組からQRごとの格子を作る。曲面推定の前に、各マーカー付近のタイミングパターンを局所的に照合する。最終結果はZXingの有効な復号結果から取得する。Structured Append情報も復号結果を維持する。複数のQRの結果を位置と内容で統合する。

モデルは2種類ある。

- マーカーモデルは32×32の局所画像から、位置検出パターンの確信度、中心、縦横の局所的な向きと間隔を推定する。全結合層の寸法は1024→160→80→7。公開写真による補正を、マーカーかどうかの出力だけに加える。
- 曲面モデルは3つのマーカーの局所的な向き・間隔を、それらの中心が作る座標系で表した12個の値とQRサイズを入力とし、9×9格子の変位を出力する。寸法は13→128→128→162。固定模様を使う局所的な調整とアライメントパターンによる補間を加える。圧縮されたセルは複数点を標本化する。

配布する `vendor/qr-networks.json` はlittle-endian float32をbase64化した約1.16 MBのファイル。モデルはページと同じ配信元から取得し、学習済み層の計算はWebGPUのcompute shaderで行う。ページとWorkerの両方でアダプター、モデル読込、シェーダー、読戻しを確認する。GPUが利用できない、拒否された、モデルをロードできない、デバイスを失った場合にはNNを停止して既存処理を使い、ページ下部のコミットIDの後ろに `No GPU` を表示する。NNで復号できなかった画像にも既存処理を試す。

## 学習の再現

Python 3.12、numpy 2.3.5、PyTorch 2.15.0+cpuを使用した。CPUで学習でき、PyTorchは開発用依存だけである。

```sh
python -m venv /tmp/qr-nn-venv
/tmp/qr-nn-venv/bin/pip install numpy==2.3.5
/tmp/qr-nn-venv/bin/pip install torch==2.15.0+cpu --index-url https://download.pytorch.org/whl/cpu
/tmp/qr-nn-venv/bin/python scripts/nn/train.py --output /tmp/qr-nn-trained --deploy /tmp/qr-nn-baseline.json
```

学習スクリプトはそれぞれ65,536例と別シードの検証用4,096例を生成する。マーカーはQR仕様の固定模様に、向き・縦横比・ずれ・照明勾配・ノイズを加え、ランダムなデータ模様やアライメントパターンを負例にする。曲面は透視投影した円筒の幾何情報から生成し、曲げの方向・強さ・中心のずれ・視点・QRサイズを変える。折り返す格子を除く。学習回数は曲面6,000、マーカー8,000更新、バッチ1,024。乱数シード、モデルの寸法、損失関数をスクリプトに記録している。共有された写真・録画・抽出した本文を学習には使わない。

初回の追加学習（`f9490bd`）は [libphash の公開写真集](https://github.com/gudoshnikovn/libphash-site-corpus/tree/8969aa7af09b3e400395669ae35d3936fb446a90) に収録されたWikimedia Commonsの写真200枚を使う。同梱マニフェストに原典・作者・CC0またはパブリックドメインの表記がある。撮影者単位で163枚を学習用、37枚を評価用に分けた。元画像を確認し、読み取れるQRがある画像は負例の抽出時にも除外する。各画像からカメラと同じ入力を抽出し、学習前のNNが誤って受理する領域を最大32件採る。採取した領域、元写真はリポジトリに含めない。

```sh
git clone https://github.com/gudoshnikovn/libphash-site-corpus.git /tmp/qr-public-corpus
git -C /tmp/qr-public-corpus checkout 8969aa7af09b3e400395669ae35d3936fb446a90
git show 126e742:vendor/qr-networks.json > /tmp/qr-nn-baseline.json
/tmp/qr-nn-venv/bin/pip install Pillow==13.0.0
/tmp/qr-nn-venv/bin/python scripts/nn/prepare-negatives.py /tmp/qr-public-corpus /tmp/qr-backgrounds
deno run --allow-read --allow-write scripts/nn/mine-negatives.ts /tmp/qr-backgrounds/train /tmp/qr-patches/train /tmp/qr-nn-baseline.json
deno run --allow-read --allow-write scripts/nn/mine-negatives.ts /tmp/qr-backgrounds/holdout /tmp/qr-patches/holdout /tmp/qr-nn-baseline.json
/tmp/qr-nn-venv/bin/python scripts/nn/refine-marker.py /tmp/qr-nn-baseline.json /tmp/qr-patches/train /tmp/qr-patches/holdout vendor/qr-networks.json
```

初回の追加学習ではカメラが拾った5,085の負例と合成例を使い、既存のマーカー位置・向きと格子の重みを固定する。合成曲面QRで正読率を維持するように補正の強さを調整した。評価用写真では従来のマーカー判定を通過した1,129件中729件が再学習後も通過した。別シードで生成した合成マーカーの通過率は2,828/2,933から2,801/2,933になった。いずれも復号より前の数値。同じ37枚をCPU照合実装で曲面NN経路に通すと、構造チェック通過後の格子推定は463件から86件に減った。

### 学習用コーパスの拡張

[imazen-26 Originals v2026.10.19](https://github.com/imazen/imazen-26-originals/tree/v2026.10.19) のパブリックドメイン・CC0画像を追加した。元の分割を使い、train 840枚、validate 517枚、test 322枚を取得した。追加の学習用840枚には実写172枚、文書・図220枚、生成画像448枚が含まれる。配布された一覧と画像の SHA-256 を検証する。スクリーンショットは一覧の段階で除外する。

直前のモデルでカメラと同じ候補を採取し、ZXingが復号できたQRを含む画像を1枚除いた。復号できない画像でも、位置検出パターンと強く一致する切り出しは負例から外す。追加データから採れた14,684件と前回学習用の5,085件を合わせ、マーカー判定のみ再学習した。test 分割は重みと補正強度を固定してから評価した。

CPU照合実装で、test 322枚のうちNN曲面推定に進んだ画像は11枚から3枚に、格子推定試行は484件から306件に減った。同じtest分割の写真70枚では115件から10件に減った。初回の追加学習で使った評価用写真37枚では86件から6件に減った。合成した曲面QRのNN経路単独の正読は、30°で3/8、40°で0/8を維持した。

```sh
# Pillow と ImageMagick が必要。HEIC を扱える ImageMagick を使用
/tmp/qr-nn-venv/bin/python scripts/nn/prepare-imazen.py /tmp/qr-imazen train validate test
git show f9490bd:vendor/qr-networks.json > /tmp/qr-previous-model.json
deno run --allow-read --allow-write scripts/nn/mine-negatives.ts /tmp/qr-imazen/train /tmp/qr-imazen-patches/train /tmp/qr-previous-model.json
deno run --allow-read --allow-write scripts/nn/mine-negatives.ts /tmp/qr-imazen/validate /tmp/qr-imazen-patches/validate /tmp/qr-previous-model.json
/tmp/qr-nn-venv/bin/python scripts/nn/refine-marker.py /tmp/qr-nn-baseline.json /tmp/qr-imazen-patches/train /tmp/qr-imazen-patches/validate vendor/qr-networks.json --extra-train /tmp/qr-patches/train --steps 2400
deno run --allow-read scripts/nn/evaluate-backgrounds.ts /tmp/qr-imazen/test /tmp/qr-previous-model.json vendor/qr-networks.json
```

`mine-negatives.ts` と `evaluate-backgrounds.ts` は、第4引数の `0/3`、`1/3`、`2/3` のような指定で、ファイル名順に分割した画像を並列処理できる。評価結果の件数は分割をまたいで加算できる。

## 検証

```sh
deno task build
deno task check
deno task test
CHROME_BIN=/usr/bin/chromium deno task test:gpu
```

`neural_test.ts` は、学習器と別実装の3D描画との格子座標の誤差、3つのQR・9つのマーカーからの本文の完全一致、GPU利用不可時の初期化を検査する。モデルの重みをCPUで照合する関数はテスト用ファイルに置く。アプリのNN推論はWebGPU上で実行する。

`test:gpu` はChromiumのWebGPUで2モデルの数値をCPUの照合結果と比較し、アプリのカメラ入力から本文表示までを確認する。3方式の切り替え、アダプター欠如・拒否、デバイス喪失時のフォールバックと `No GPU` 表示も検査する。この環境ではSwiftShaderを使用するため、端末GPUの処理時間の評価には実機が必要となる。

`deno task compare:camera /tmp/qr-backgrounds/holdout` は同じPNGを3方式のカメラWorkerに渡し、背景では1フレーム、合成曲面QRでは同じ画像を最大4フレーム入力する。格子推定試行数、Worker往復時間の中央値、正読した入力の初回復号時間の中央値をJSONで出力する。背景ディレクトリは省略できる。第2引数に重みファイルを指定すると旧モデルも比較できる。既定はSwiftShaderで、`NATIVE_GPU=1` でブラウザーの既定のGPU設定を使用する。計測にはデバッグ情報の収集時間を含む。

初回の追加学習版（`f9490bd`）で3方式をChromiumとSwiftShaderで比較した。背景写真37枚の復号は全方式で0件。正読は合成曲面QRの元バイト列との完全一致。

| 方式 | 背景での格子推定（37枚の合計） | 背景1フレームの中央値 | 30°の正読 | 初回復号の中央値（30°で成功した画像） | 40°の正読 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 従来のみ | 0 | 337 ms | 4/8 | 1,025 ms | 0/8 |
| マーカーNN・従来曲面 | 82 | 610 ms | 4/8 | 1,033 ms | 0/8 |
| マーカーNN・曲面NN | 82 | 658 ms | 4/8 | 1,145 ms | 0/8 |

NN経路単独の完全復号は30度で3/8、40度で0/8。正しい格子が与えられた場合と比べて、特に圧縮されたマーカーの検出と局所的な向きの推定に改善が必要である。
