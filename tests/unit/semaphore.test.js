// tests/unit/semaphore.test.js
import { describe, it, expect } from 'vitest';
import { createSemaphore } from '../../utils/semaphore.js';

/** limit 個までしか同時に走らないことを、実行中のピークで確認する */
async function runAll(sem, count, work) {
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: count }, async () => {
    await sem.acquire();
    active += 1;
    peak = Math.max(peak, active);
    try {
      await work();
    } finally {
      active -= 1;
      sem.release();
    }
  }));
  return peak;
}

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('createSemaphore', () => {
  it('上限を超えて同時に走らせない', async () => {
    const sem = createSemaphore(3);
    expect(await runAll(sem, 20, tick)).toBe(3);
  });

  it('上限 1 なら直列になる', async () => {
    const sem = createSemaphore(1);
    expect(await runAll(sem, 8, tick)).toBe(1);
  });

  it('全部終わると active も待ち行列も空になる', async () => {
    const sem = createSemaphore(2);
    await runAll(sem, 10, tick);
    expect(sem.active()).toBe(0);
    expect(sem.waiting()).toBe(0);
  });

  // 起こされた後に再確認しないと、同時に起きた待ち手が上限を超えて通過する
  it('待ち手が同時に起きても上限を超えない', async () => {
    const sem = createSemaphore(2);
    await sem.acquire();
    await sem.acquire();
    let passed = 0;
    const waiters = [sem.acquire().then(() => { passed += 1; }), sem.acquire().then(() => { passed += 1; })];
    // 1 つだけ空ける → 通過できるのは 1 つだけ
    sem.release();
    await tick();
    expect(passed).toBe(1);
    sem.release();
    await Promise.all(waiters);
    expect(passed).toBe(2);
  });

  it('二重 release で上限が増えない', async () => {
    const sem = createSemaphore(1);
    await sem.acquire();
    sem.release();
    sem.release();
    sem.release();
    expect(sem.active()).toBe(0);
    expect(await runAll(sem, 5, tick)).toBe(1);
  });

  it('不正な上限は 1 に丸める', async () => {
    for (const bad of [0, -3, NaN, undefined, 'x']) {
      expect(await runAll(createSemaphore(bad), 4, tick)).toBe(1);
    }
  });

  it('小数は切り捨てる', async () => {
    expect(await runAll(createSemaphore(2.9), 6, tick)).toBe(2);
  });

  it('work が投げても解放される（finally で release する前提）', async () => {
    const sem = createSemaphore(1);
    await expect(Promise.all([
      (async () => { await sem.acquire(); try { throw new Error('boom'); } finally { sem.release(); } })(),
    ])).rejects.toThrow('boom');
    expect(sem.active()).toBe(0);
    await sem.acquire();
    expect(sem.active()).toBe(1);
  });
});
