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
