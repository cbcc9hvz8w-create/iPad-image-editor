import assert from "node:assert/strict";
import test from "node:test";
import { createInitialEdit, cropPixelDimensions, dimensionsForLongEdge, outputFilename } from "../app/image-utils.ts";

test("640×623を長辺320pxへ実寸リサイズする", () => {
  assert.deepEqual(dimensionsForLongEdge(320, 640 / 623), { width: 320, height: 312 });
});

test("640×623を各プリセットへアスペクト比維持で計算する", () => {
  assert.deepEqual(dimensionsForLongEdge(3200, 640 / 623), { width: 3200, height: 3115 });
  assert.deepEqual(dimensionsForLongEdge(1200, 640 / 623), { width: 1200, height: 1168 });
  assert.deepEqual(dimensionsForLongEdge(800, 640 / 623), { width: 800, height: 779 });
});

test("中央50%トリミングは画像データのpx数を半分にする", () => {
  assert.deepEqual(cropPixelDimensions(2000, 1200, { x: .25, y: .25, w: .5, h: .5 }), { width: 1000, height: 600 });
});

test("PNG/JPEGの出力名を正しい拡張子で作る", () => {
  const edit = createInitialEdit(640, 623);
  edit.output.format = "image/jpeg";
  edit.output.suffix = "resized_320";
  assert.equal(outputFilename("IMG_1234.PNG", edit), "IMG_1234_resized_320.jpg");
  edit.output.format = "image/png";
  edit.output.filenameMode = "sequence";
  assert.equal(outputFilename("anything.jpg", edit, 9), "IMG_010_resized_320.png");
});
