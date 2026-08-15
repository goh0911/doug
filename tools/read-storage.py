#!/usr/bin/env python3
"""Chrome 拡張の chrome.storage.local（LevelDB）を依存なしで読む（開発用）。

DevTools の Console を開かずに実機の状態を確認したいときに使う。tools/gloss-diag.js
などは拡張のページで実行する必要があるが、こちらはターミナルだけで完結する。

使い方:
  # Chrome は起動したままでよい。必ず複製してから読む（LOCK を掴まないため）
  ID=$(python3 - <<'EOF'
import pathlib, re
base = pathlib.Path.home() / "Library/Application Support/Google/Chrome/Default/Local Extension Settings"
for d in base.iterdir():
    if any(f.suffix in (".log", ".ldb") and b"glossDefs" in f.read_bytes() for f in d.iterdir()):
        print(d.name); break
EOF
)
  mkdir -p /tmp/doug-db && cp "$HOME/Library/Application Support/Google/Chrome/Default/Local Extension Settings/$ID/"* /tmp/doug-db/
  python3 tools/read-storage.py /tmp/doug-db

注意:
  - **読み取り専用**。複製したファイルしか触らない
  - .ldb（確定済み）だけを読む。直近の書き込みは .log に残っていて反映されないことがある
  - Snappy と LevelDB の SST を自前で解いている（外部依存を足さないため）
"""
import json, pathlib, struct, sys

# ---------- Snappy（raw format）の伸長 ----------
def snappy_decompress(data):
    pos, shift, ulen = 0, 0, 0
    while True:
        b = data[pos]; pos += 1
        ulen |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    out = bytearray()
    n = len(data)
    while pos < n:
        tag = data[pos]; pos += 1
        kind = tag & 0x03
        if kind == 0:  # literal
            ln = tag >> 2
            if ln < 60:
                ln += 1
            else:
                extra = ln - 59
                ln = int.from_bytes(data[pos:pos + extra], 'little') + 1
                pos += extra
            out += data[pos:pos + ln]; pos += ln
        else:
            if kind == 1:
                ln = 4 + ((tag >> 2) & 0x07)
                off = ((tag >> 5) << 8) | data[pos]; pos += 1
            elif kind == 2:
                ln = (tag >> 2) + 1
                off = int.from_bytes(data[pos:pos + 2], 'little'); pos += 2
            else:
                ln = (tag >> 2) + 1
                off = int.from_bytes(data[pos:pos + 4], 'little'); pos += 4
            if off == 0 or off > len(out):
                raise ValueError('不正な copy offset')
            start = len(out) - off
            for i in range(ln):           # 重なりを許すため 1 バイトずつ
                out.append(out[start + i])
    if len(out) != ulen:
        raise ValueError(f'長さ不一致 {len(out)} != {ulen}')
    return bytes(out)


def varint(buf, pos):
    val, shift = 0, 0
    while True:
        b = buf[pos]; pos += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, pos
        shift += 7


def read_block(raw, offset, size):
    body = raw[offset:offset + size]
    ctype = raw[offset + size]          # 0=非圧縮 1=snappy
    return snappy_decompress(body) if ctype == 1 else body


def parse_block(block):
    """LevelDB のブロックから (key, value) を取り出す"""
    num_restarts = struct.unpack('<I', block[-4:])[0]
    end = len(block) - 4 - num_restarts * 4
    pos, prev = 0, b''
    out = []
    while pos < end:
        shared, pos = varint(block, pos)
        non_shared, pos = varint(block, pos)
        vlen, pos = varint(block, pos)
        key = prev[:shared] + block[pos:pos + non_shared]; pos += non_shared
        val = block[pos:pos + vlen]; pos += vlen
        out.append((key, val))
        prev = key
    return out


def read_sst(path):
    raw = path.read_bytes()
    footer = raw[-48:]
    p = 0
    _, p = varint(footer, p)   # metaindex offset
    _, p = varint(footer, p)   # metaindex size
    idx_off, p = varint(footer, p)
    idx_size, p = varint(footer, p)
    index = parse_block(read_block(raw, idx_off, idx_size))
    entries = []
    for _, handle in index:
        off, q = varint(handle, 0)
        size, _ = varint(handle, q)
        try:
            entries += parse_block(read_block(raw, off, size))
        except Exception as e:
            print(f'  (ブロック {off} を読めず: {e})', file=sys.stderr)
    return entries


def read_log(path):
    """write-ahead log。非圧縮なので JSON をそのまま拾う（厳密なパースはしない）"""
    raw = path.read_bytes()
    out = {}
    for m in __import__('re').finditer(rb'series:[0-9a-f]{8,}', raw):
        out[m.group().decode()] = None
    return out


d = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
records = {}
for f in sorted(d.glob('*.ldb')):
    for key, val in read_sst(f):
        k = key[:-8].decode('utf-8', 'replace')   # 末尾 8B は seq+type
        records[k] = val

print(f'キー {len(records)} 件: {sorted(records)[:20]}\n')
for k in sorted(records):
    if not k.startswith('series:'):
        continue
    try:
        s = json.loads(records[k])
    except Exception as e:
        print(f'{k}: JSON 解析失敗 {e}'); continue
    g = (s.get('glossary') or {}).get('ja') or {}
    dd = (s.get('glossDefs') or {}).get('ja') or {}
    ok = sum(1 for v in dd.values() if not (v or {}).get('failed'))
    pats = [p.get('origin', '') for p in (s.get('urlPatterns') or [])]
    print(f"■ {k}")
    print(f"   名前          {(s.get('meta') or {}).get('name')}")
    print(f"   用語集        {len(g)} 語")
    print(f"   解説          {len(dd)} 件（成功 {ok} / 失敗 {len(dd)-ok}）")
    print(f"   recentPairs   {len(s.get('recentPairs') or [])} 件")
    print(f"   抽出予約      {s.get('extractionDue')} / 空振り連続 {s.get('extractionBarrenRuns')} / 失敗 {s.get('extractionFailures')}")
    print(f"   URL           {pats}")
    print(f"   翻訳回数      {(s.get('stats') or {}).get('translationCount')} / 抽出実行 {(s.get('stats') or {}).get('extractionRuns')}")
    print()
