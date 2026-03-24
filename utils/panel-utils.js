// utils/panel-utils.js
// content.js の IIFE 内にもコピーを保持する（IIFE 制約のため import 不可）
// content.js 側を変更した場合はこのファイルも必ず同期すること

/**
 * crop空間の bbox（%）をフルページ座標（%）に変換する
 * @param {{ left: number, top: number, width: number, height: number }} cropBbox - AI が返す crop 空間の %値
 * @param {{ x1: number, y1: number, x2: number, y2: number }} cropBox - padded crop box のピクセル座標
 * @param {number} W - フル画像の幅（px）
 * @param {number} H - フル画像の高さ（px）
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
export function transformBboxToFullPage(cropBbox, cropBox, W, H) {
  const cropW = cropBox.x2 - cropBox.x1;
  const cropH = cropBox.y2 - cropBox.y1;
  return {
    left:   (cropBox.x1 + cropBbox.left   / 100 * cropW) / W * 100,
    top:    (cropBox.y1 + cropBbox.top    / 100 * cropH) / H * 100,
    width:  cropBbox.width  / 100 * cropW / W * 100,
    height: cropBbox.height / 100 * cropH / H * 100,
  };
}

/**
 * 2つの bbox（left/top/width/height の % 形式）の IoU を計算する
 */
function calcIou(a, b) {
  const ax2 = a.left + a.width,  ay2 = a.top + a.height;
  const bx2 = b.left + b.width,  by2 = b.top + b.height;
  const ix1 = Math.max(a.left, b.left), iy1 = Math.max(a.top, b.top);
  const ix2 = Math.min(ax2, bx2),       iy2 = Math.min(ay2, by2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter === 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * IoU ベースで既存翻訳と新翻訳をマージする
 * IoU >= 0.3: 既存を incoming で置き換え（最後にマッチした incoming が勝つ）
 * IoU < 0.3:  配列末尾に追加
 * @param {Array} existing - 現在の translations 配列
 * @param {Array} incoming - 新しい translations 配列（フルページ座標に変換済み）
 * @returns {{ translations: Array, changedIndices: Set<number> }}
 */
export function mergeTranslations(existing, incoming) {
  const result = existing.slice(); // shallow copy
  const changedIndices = new Set();

  for (const newItem of incoming) {
    if (!newItem.bbox) { result.push(newItem); changedIndices.add(result.length - 1); continue; }

    let bestIdx = -1;
    let bestIou = 0;
    for (let i = 0; i < result.length; i++) {
      if (!result[i].bbox) continue;
      const iou = calcIou(result[i].bbox, newItem.bbox);
      if (iou >= 0.3 && iou > bestIou) { bestIou = iou; bestIdx = i; }
    }

    if (bestIdx >= 0) {
      result[bestIdx] = newItem;
      changedIndices.add(bestIdx);
    } else {
      result.push(newItem);
      changedIndices.add(result.length - 1);
    }
  }

  return { translations: result, changedIndices };
}
