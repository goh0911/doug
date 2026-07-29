// tests/e2e/auto-translate.spec.js
import { test, expect } from './fixtures.js';

const CBP_COMIC_URL = 'https://www.comicbookplus.com/?dlid=74171';

test.describe('自動翻訳トグル', () => {
  test('自動翻訳 ON → 翻訳が自動で開始される', async ({ page }) => {
    await page.goto(CBP_COMIC_URL, { waitUntil: 'load' });

    // 自動翻訳は checkbox ではなく button で、ON の状態は
    // .mut-btn-active クラスで表される（content.js の toggleAutoTranslate）
    const autoToggle = page.locator('#mut-toolbar #mut-btn-auto');
    await expect(autoToggle).toBeVisible({ timeout: 10_000 });

    // まだ OFF の場合のみ ON にする
    const isOn = await autoToggle.evaluate((el) => el.classList.contains('mut-btn-active'));
    if (!isOn) {
      await autoToggle.click();
    }
    await expect(autoToggle).toHaveClass(/mut-btn-active/);

    // 自動翻訳が開始されてオーバーレイが表示されることを確認
    await expect(page.locator('#mut-overlay-container')).toBeAttached({ timeout: 30_000 });
    // toHaveCount は数値しか取らないため、先頭要素の存在で「1 件以上」を表す
    await expect(page.locator('.mut-overlay').first()).toBeAttached({ timeout: 30_000 });
  });
});
