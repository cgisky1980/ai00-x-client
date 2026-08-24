# E4: 思源宋体（Noto Serif SC VF）Display 子集再生成脚本
# 源文件（需先放置）：fonts/NotoSerifSC-VF.ttf（23.96MB，勿入库）
#   下载：https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf
# 运行：pnpm --dir packages/design-system run build:fonts
#   （内部：uv run --with "fonttools[woff]" python scripts/subset-display-font.py）
# 覆盖字符 = GB2312 一级常用字(3755) + 仓库实际用字 + ASCII/中西标点
# 输出：fonts/Ai00XSerif-Display.woff2（CFF2 可变字重 200–900，约 1.54MB）
import os, sys
from fontTools import subset
from fontTools.ttLib import TTFont

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT_ROOT = os.path.dirname(os.path.dirname(PKG))
SRC = os.path.join(PKG, 'fonts', 'NotoSerifSC-VF.ttf')
OUT = os.path.join(PKG, 'fonts', 'Ai00XSerif-Display.woff2')

if not os.path.exists(SRC):
    print(f'[subset] missing source {SRC}\n[subsets] download: https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf')
    sys.exit(1)

chars = set()

# 1) ASCII 可打印
chars.update(chr(c) for c in range(0x20, 0x7F))

# 2) 常用西文标点/空格
chars.update(map(chr, [0xA0, 0xA9, 0xB7, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2020, 0x2021, 0x2026]))

# 3) CJK 标点/引号/书名号/全角
for a, b in [(0x3001, 0x301F), (0xFF01, 0xFF65)]:
    chars.update(chr(c) for c in range(a, b + 1))

# 4) GB2312 一级常用字（区位 16-55 区，3755 字）
for hi in range(0xB0, 0xD8):
    for lo in range(0xA1, 0xFF):
        try:
            ch = bytes([hi, lo]).decode('gb2312')
            if 0x4E00 <= ord(ch) <= 0x9FA5:
                chars.add(ch)
        except UnicodeDecodeError:
            pass

# 5) 仓库实际用到的全部 CJK/全角字符（兜底覆盖二级字与专名）
scan_dirs = [os.path.join(CLIENT_ROOT, 'src'), os.path.join(PKG, 'src')]
for d in scan_dirs:
    for dirpath, _, files in os.walk(d):
        for f in files:
            if not f.endswith(('.ts', '.tsx', '.html', '.css', '.scss', '.json')):
                continue
            try:
                text = open(os.path.join(dirpath, f), encoding='utf-8', errors='ignore').read()
            except OSError:
                continue
            for ch in text:
                cp = ord(ch)
                if 0x2E80 <= cp <= 0x9FFF or 0xFF00 <= cp <= 0xFFEF or 0x2000 <= cp <= 0x206F:
                    chars.add(ch)

text = ''.join(sorted(chars))
print(f'[subset] char set: {len(chars)} unique')

opts = subset.Options()
opts.flavor = 'woff2'
# Display 场景仅需 kern；vert/vrt2/tnum 等 GSUB closure 会显著增大 CFF2 子集
opts.layout_features = ['kern']
opts.name_IDs = [1, 2, 3, 4, 6]
opts.drop_tables += ['FFTM']
opts.hinting = False
opts.legacy_kern = False
font = subset.load_font(SRC, opts)
subsetter = subset.Subsetter(options=opts)
subsetter.populate(text=text)
subsetter.subset(font)

# 统一 family 名，避免与系统 Noto Serif SC 混淆
name = font['name']
for rec in list(name.names):
    if rec.nameID in (1, 16):
        name.setName('Ai00 X Serif', rec.nameID, rec.platformID, rec.platEncID, rec.langID)
    elif rec.nameID in (2, 17):
        name.setName('Display VF', rec.nameID, rec.platformID, rec.platEncID, rec.langID)
    elif rec.nameID == 4:
        name.setName('Ai00 X Serif Display VF', rec.nameID, rec.platformID, rec.platEncID, rec.langID)
    elif rec.nameID == 6:
        name.setName('Ai00XSerif-Display-VF', rec.nameID, rec.platformID, rec.platEncID, rec.langID)

subset.save_font(font, OUT, opts)
size = os.path.getsize(OUT)
print(f'[subset] wrote {OUT}: {size/1024/1024:.2f} MB ({size} bytes)')

# 自检：子集 cmap 是否覆盖全部目标字符
check = TTFont(OUT)
cmap = check.getBestCmap()
missing = [c for c in chars if ord(c) not in cmap and not c.isspace()]
print(f'[subset] coverage missing: {len(missing)}', (''.join(missing[:20]) if missing else ''))
sys.exit(0 if size <= int(1.55 * 1024 * 1024) else 1)
