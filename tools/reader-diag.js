// tools/reader-diag.js — 新しいコミックリーダーの DOM 構造を採取する実機診断（開発用。拡張には同梱しない）
//
// 目的: Marvel Comics powered by WEBTOON（marvel.webtoon.com, 2026-11-16 公開）のように、
//   描画方式が未確認のリーダーで、Doug が前提にしている点を一度に確かめる。
//   「Doug が動かない」と結論する前に、ここで出る事実から原因を切り分ける。
//
// 実行場所: リーダーでコミックを開いたページの DevTools Console（ページ既定のコンテキスト）。
//   chrome.* は使わないので拡張の world でなくてよい。ファイルの中身を貼り付けて実行する。
//
// 使い方:
//   dougReader()            現在の状態を 1 回採取して JSON を出力する
//   dougReaderWatch(20)     20 秒間、DOM の変化を記録する。その間にページ送り・スクロールを行う。
//                           終わると要約を出力する（既定 15 秒）
//
// 通信も書き込みも行わない（DOM を読むだけ）。画像 URL は署名付きトークンを含みうるので、
// クエリとハッシュを落として出力する。
//
// 出力が答えること（content.js の前提との対応）:
//   candidates   findLargestVisibleImage の 4 グループ（blob img / svg image / img / canvas）の
//                候補と矩形。**この関数は選択を再実装しない**。どの 1 枚が選ばれるかは
//                Doug の翻訳ボタンを押して実際の挙動で確かめること（規則を書き写すと本番とずれる）
//   titles       detectSeries が見る title / og:title / h1。シリーズ名が取れる書式か
//   scrollers    縦スクロールのコンテナ（画像が縦に複数並ぶ構造か）
//   crossOrigin  画像の配信元が別オリジンか（canvas 汚染 → URL フェッチへのフォールバックになる）
//   watch        ページ送り時に何が入れ替わるか（content.js の MutationObserver の前提）

(() => {
  /** 署名付き URL を想定し、クエリとハッシュを落とす */
  const safeUrl = (u) => {
    // data: は URI 本体が巨大になり origin も "null" になるので、種別だけ出す
    if (String(u).startsWith('data:')) return String(u).slice(0, String(u).indexOf(',') + 1) + '…';
    try {
      const x = new URL(u, location.href);
      return x.origin + x.pathname;
    } catch {
      return String(u).slice(0, 80);
    }
  };

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
  };

  const inViewport = (r) =>
    r.x >= 0 && r.x < innerWidth && r.y >= -r.h && r.y < innerHeight;

  const describe = (el, extra = {}) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    cls: typeof el.className === 'string' ? el.className.slice(0, 80) : undefined,
    rect: rectOf(el),
    inViewport: inViewport(rectOf(el)),
    ...extra,
  });

  const imgInfo = (el) => {
    const src = el.currentSrc || el.src || '';
    let cross = null;
    // data: / blob: は配信元の概念が無いので null のまま（別オリジン扱いにしない）
    if (!src.startsWith('data:') && !src.startsWith('blob:')) {
      try { cross = new URL(src, location.href).origin !== location.origin; } catch { /* 不正な URL */ }
    }
    return describe(el, {
      src: src.startsWith('blob:') ? 'blob:' : safeUrl(src),
      isBlob: src.startsWith('blob:'),
      crossOrigin: cross,
      crossOriginAttr: el.getAttribute('crossorigin'),
      natural: el.naturalWidth ? `${el.naturalWidth}x${el.naturalHeight}` : undefined,
      lazy: el.loading === 'lazy' || el.hasAttribute('data-src') || undefined,
    });
  };

  /** 縦にスクロールできる祖先を拾う（縦スクロール型のリーダー判定用） */
  const scrollers = () => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 200) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') {
          out.push({ ...describe(el), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: oy });
        }
      }
    }
    return out.slice(0, 10);
  };

  window.dougReader = () => {
    const imgs = [...document.querySelectorAll('img')];
    const big = (el) => { const r = el.getBoundingClientRect(); return r.width >= 200 && r.height >= 200; };
    const report = {
      url: safeUrl(location.href),
      origin: location.origin,
      viewport: { w: innerWidth, h: innerHeight },
      titles: {
        title: document.title,
        ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? null,
        h1: document.querySelector('h1')?.textContent?.trim() ?? null,
      },
      candidates: {
        blobImg: imgs.filter((e) => e.src.startsWith('blob:') && big(e)).map(imgInfo),
        svgImage: [...document.querySelectorAll('svg image')].filter(big).map((e) => describe(e, { href: safeUrl(e.getAttribute('href') || e.getAttribute('xlink:href') || '') })),
        img: imgs.filter((e) => !e.src.startsWith('blob:') && big(e)).map(imgInfo),
        canvas: [...document.querySelectorAll('canvas')].filter(big).map((e) => describe(e, { px: `${e.width}x${e.height}` })),
      },
      scrollers: scrollers(),
      shadowRoots: [...document.querySelectorAll('*')].filter((e) => e.shadowRoot).length,
      iframes: [...document.querySelectorAll('iframe')].map((f) => ({ src: safeUrl(f.src), rect: rectOf(f) })),
      note: '候補の列挙のみ。どれが選ばれるかは Doug の翻訳ボタンで確かめる（選択規則は再実装していない）',
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  };

  window.dougReaderWatch = (seconds = 15) => {
    const log = [];
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0);
    const kind = (n) => (n.nodeType === 1 ? n.tagName.toLowerCase() : `#${n.nodeType}`);
    const interesting = (n) => n.nodeType === 1 && (['img', 'image', 'canvas', 'svg', 'picture'].includes(kind(n)) || n.querySelector?.('img,image,canvas'));
    const mo = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) if (interesting(n)) log.push({ t: at(), ev: 'add', node: kind(n) });
          for (const n of m.removedNodes) if (interesting(n)) log.push({ t: at(), ev: 'remove', node: kind(n) });
        } else if (m.type === 'attributes' && ['src', 'href', 'xlink:href', 'srcset'].includes(m.attributeName)) {
          log.push({ t: at(), ev: 'attr', node: kind(m.target), attr: m.attributeName });
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'xlink:href', 'srcset'] });
    const urlLog = [];
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...a) { urlLog.push({ t: at(), ev: 'pushState', url: safeUrl(a[2] ?? '') }); return origPush.apply(this, a); };
    history.replaceState = function (...a) { urlLog.push({ t: at(), ev: 'replaceState', url: safeUrl(a[2] ?? '') }); return origReplace.apply(this, a); };
    const onPop = () => urlLog.push({ t: at(), ev: 'popstate', url: safeUrl(location.href) });
    addEventListener('popstate', onPop);
    console.log(`[dougReaderWatch] ${seconds} 秒間記録します。ページ送り／スクロールを行ってください`);
    setTimeout(() => {
      mo.disconnect();
      history.pushState = origPush;
      history.replaceState = origReplace;
      removeEventListener('popstate', onPop);
      const tally = {};
      for (const e of log) { const k = `${e.ev}:${e.node}${e.attr ? '@' + e.attr : ''}`; tally[k] = (tally[k] || 0) + 1; }
      const out = { seconds, tally, urlChanges: urlLog, firstEvents: log.slice(0, 40), totalEvents: log.length };
      console.log(JSON.stringify(out, null, 2));
      window.__dougReaderWatchResult = out;
    }, seconds * 1000);
  };

  console.log('[reader-diag] dougReader() / dougReaderWatch(秒) を使えます');
})();
