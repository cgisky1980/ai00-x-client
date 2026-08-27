# 生成「策」面板导航单字印记：字符 → SVG path（思源宋体 Display 子集，字重 700）
#
# 源字体：packages/design-system/fonts/Ai00XSerif-Display.woff2（E4 自托管子集，
# GB2312 一级常用字全覆盖，导航单字必在其中）。
# 输出：src/web-ui/src/tools/todo/components/NavCharMarks.tsx（自动生成，勿手改）。
#
# 运行（client 目录下）：
#   uv run --with "fonttools[woff]" python scripts/gen-nav-char-marks.py
# 改字符/字重：改下方 CHARS / WEIGHT 后重跑（i18n 换字时同法再生成）。
import os

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(ROOT, "packages", "design-system", "fonts", "Ai00XSerif-Display.woff2")
OUT = os.path.join(
    ROOT, "src", "web-ui", "src", "tools", "todo", "components", "NavCharMarks.tsx"
)

# 导航单字（行=笃行之事（看板：谋→计划→执行→成） / 恒=恒常之事 / 志=目标方略 / 修=修行成长 / 迹=已成之迹）
CHARS = ["行", "恒", "志", "修", "迹"]
WEIGHT = 700  # 印记观感：重一档在小尺寸下立得住
VIEWBOX = 1000  # 与字体 upem 一致（思源宋体 1000）

# 组件命名（语义命名，与 CHARS 一一对应；i18n 换字不改代码名）
NAMES = ["Action", "Habit", "Goal", "Grow", "Trail"]

font = TTFont(FONT)
instantiateVariableFont(font, {"wght": WEIGHT}, inplace=True)
upem = font["head"].unitsPerEm
if upem != VIEWBOX:
    raise SystemExit(f"unexpected upem {upem} (script assumes {VIEWBOX})")

cmap = font.getBestCmap()
glyph_set = font.getGlyphSet()

# 1) 取字形 + 各自边界框
glyphs = []
for ch in CHARS:
    gname = cmap.get(ord(ch))
    if not gname:
        raise SystemExit(f"[gen-nav-marks] subset font missing glyph for U+{ord(ch):04X} {ch}")
    pen = SVGPathPen(glyph_set)
    glyph_set[gname].draw(pen)
    d = pen.getCommands()
    if not d.strip():
        raise SystemExit(f"[gen-nav-marks] empty outline for {ch}")
    bp = BoundsPen(glyph_set)
    glyph_set[gname].draw(bp)
    if bp.bounds is None:
        raise SystemExit(f"[gen-nav-marks] no bounds for {ch}")
    glyphs.append((ch, d, bp.bounds))

# 2) 五字联合边界框（全宽形声字共享同一 em 网格，联合框即统一对齐基准）
x_min = min(b[0] for _, _, b in glyphs)
y_min = min(b[1] for _, _, b in glyphs)
x_max = max(b[2] for _, _, b in glyphs)
y_max = max(b[3] for _, _, b in glyphs)
w = x_max - x_min
h = y_max - y_min
pad_x = (VIEWBOX - w) / 2
pad_y = (VIEWBOX - h) / 2
# SVG 变换（右起作用）：先 scale(1,-1) 翻转 y 轴（字体 y 向上），再平移入框
tx = -x_min + pad_x
ty = y_max + pad_y

# 3) 生成 TSX
lines = [
    "/**",
    " * NavCharMarks — 导航单字印记（自动生成，勿手改）。",
    " * 生成器：client/scripts/gen-nav-char-marks.py（思源宋体 Display 子集 wght=700，",
    " * 字形轮廓 → SVG path，联合边界框居中于 1000×1000 viewBox）。",
    " * 改字符/字重请改脚本重跑：uv run --with \"fonttools[woff]\" python scripts/gen-nav-char-marks.py",
    " */",
    "import React from 'react';",
    "",
    "const VIEWBOX = 1000;",
    "",
    "function charMark(d: string): React.FC<{ size?: number }> {",
    "  const Mark: React.FC<{ size?: number }> = ({ size = 16 }) => (",
    "    <svg",
    "      width={size}",
    "      height={size}",
    f"      viewBox={{`0 0 ${{VIEWBOX}} ${{VIEWBOX}}`}}",
    "      fill=\"currentColor\"",
    "      aria-hidden=\"true\"",
    "      focusable=\"false\"",
    "    >",
    f"      <path d={{d}} transform={{`translate({tx} {ty}) scale(1 -1)`}} />",
    "    </svg>",
    "  );",
    "  return Mark;",
    "}",
    "",
]
for (ch, d, _), name in zip(glyphs, NAMES):
    lines.append(f"/** 「{ch}」印记 */")
    lines.append(f"export const NavMark{name} = charMark('{d}');")
    lines.append("")

with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(lines))

print(f"[gen-nav-marks] wrote {OUT}")
print(f"[gen-nav-marks] chars={''.join(CHARS)} wght={WEIGHT} union=[{x_min},{y_min},{x_max},{y_max}]")
