// tests/e2e/gloss-popup.spec.js
import { test, expect } from './fixtures.js';

// translation.spec.js と同じ無料コミックページ（ログイン不要）
const CBP_COMIC_URL = 'https://www.comicbookplus.com/?dlid=74171';

test.describe('固有名詞解説ポップアップ', () => {
  test('span 化しても既存のオーバーレイ描画が壊れない', async ({ page }) => {
    await page.goto(CBP_COMIC_URL, { waitUntil: 'load' });

    // ツールバーの「翻訳」ボタンをクリック
    const translateBtn = page.locator('#mut-toolbar').getByRole('button', { name: /翻訳/ });
    await expect(translateBtn).toBeVisible({ timeout: 10_000 });
    await translateBtn.click();

    // 翻訳オーバーレイコンテナが DOM に現れることを確認
    await expect(page.locator('#mut-overlay-container')).toBeAttached({ timeout: 30_000 });
    // 少なくとも 1 つのオーバーレイが表示される
    await expect(page.locator('.mut-overlay').first()).toBeVisible({ timeout: 30_000 });

    // textContent は span を含めても連結されるため、訳文が読めることに変わりはない
    const text = await page.locator('.mut-overlay-text').first().textContent();
    expect(text).toBeTruthy();
    expect(text.trim().length).toBeGreaterThan(0);
  });

  test('辞書機能が無効なら下線用の span を生成しない', async ({ page }) => {
    await page.goto(CBP_COMIC_URL, { waitUntil: 'load' });

    const translateBtn = page.locator('#mut-toolbar').getByRole('button', { name: /翻訳/ });
    await expect(translateBtn).toBeVisible({ timeout: 10_000 });
    await translateBtn.click();
    await expect(page.locator('#mut-overlay-container')).toBeAttached({ timeout: 30_000 });

    // glossEnabled の既定は false（Task 9）。span も popup も現れない
    await expect(page.locator('.doug-gloss-term')).toHaveCount(0);
    await expect(page.locator('.doug-gloss-popup')).toHaveCount(0);
  });
});
