import h from "solid-js/h";

const methods = [
  ["標準", "元画像をそのまま読み取る。"],
  [
    "輪郭補正",
    "輪郭を強調して読み取る。カメラでは元画像と追跡領域の結果も使う。",
  ],
  ["影補正", "局所的にしきい値を変えて、影や照明むらのある画像を読み取る。"],
  ["曲面補正", "QR の模様に沿う格子を推定し、セルを取り直して復号する。"],
  [
    "自動",
    "通常読み取りと各補正を組み合わせる。カメラでは検出結果に応じて補正を追加する。",
  ],
];
export function scanGuide() {
  return h(
    "details",
    { class: "scan-guide" },
    h("summary", "読み取り方法の違い"),
    h(
      "figure",
      { class: "scan-flow" },
      h("figcaption", "2つの選択欄が変える処理"),
      h(
        "div",
        { class: "scan-flow-row" },
        h("span", { class: "scan-flow-node" }, "画像・カメラ"),
        h("span", { "aria-hidden": "true" }, "→"),
        h(
          "span",
          { class: "scan-flow-node scan-flow-choice" },
          "読み取り方法",
          h("small", "試す補正を選ぶ"),
        ),
      ),
      h(
        "div",
        { class: "scan-flow-branches" },
        h(
          "div",
          { class: "scan-flow-branch" },
          h("span", { "aria-hidden": "true" }, "↓"),
          h(
            "span",
            { class: "scan-flow-node" },
            "元画像・輪郭・影",
            h("small", "画像を読み取りに渡す"),
          ),
        ),
        h(
          "div",
          { class: "scan-flow-branch" },
          h("span", { "aria-hidden": "true" }, "↓"),
          h(
            "span",
            { class: "scan-flow-node" },
            "曲面補正",
            h("small", "「自動」「曲面補正」で使う"),
          ),
          h("span", { "aria-hidden": "true" }, "↓"),
          h(
            "span",
            { class: "scan-flow-node scan-flow-choice" },
            "曲面推定",
            h("small", "従来の幾何モデル / NNの格子予測"),
          ),
        ),
      ),
      h(
        "div",
        { class: "scan-flow-branch" },
        h("span", { "aria-hidden": "true" }, "↓"),
        h("span", { class: "scan-flow-node" }, "ZXing で復号"),
      ),
    ),
    h(
      "dl",
      { class: "scan-guide-methods" },
      ...methods.flatMap(([name, detail]) => [
        h("dt", name),
        h("dd", detail),
      ]),
    ),
    h(
      "p",
      "WebGPU が使えると、どちらの曲面推定でもマーカーの評価に NN を使います。NN の格子で読めない場合や GPU が使えない場合は、従来の曲面補正を試します。",
    ),
    h(
      "p",
      "カメラの「解析を重ねる」は解析済みのフレームを表示します。その状態で録画すると、対応ブラウザーでは注釈入りの動画を保存できます。",
    ),
  );
}
