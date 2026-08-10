import { Category } from "@underlay/desktop/types"
import { ICON_MAP } from "@underlay/lib/icons"
import { cn } from "@underlay/lib/utils"

interface DesktopCategoryProps {
    category: Category
    onMouseEnter: (rect: DOMRect, label: string) => void
    onMouseLeave: () => void
}

export function DesktopCategory({ category, onMouseEnter, onMouseLeave }: DesktopCategoryProps) {
    const Icon = category.icon ? ICON_MAP[category.icon] : null

    const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect()
        onMouseEnter(rect, category.name)
    }

    return (
        <div
            className={cn("desktop-category w-full h-full flex items-center justify-center relative overflow-hidden cursor-pointer rounded-xl")}
            // 背景色由外层 ItemWrapper 统一控制（GridItem.color）
            // 仅当外层未提供颜色时，回退到 category.color 或默认蓝
            style={{
                backgroundColor: 'transparent',
                color: 'white'
            }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            {Icon ? (
                <Icon className="w-1/2 h-1/2" strokeWidth={1.5} />
            ) : (
                <span className="text-4xl font-bold">{category.name.charAt(0)}</span>
            )}
        </div>
    )
}
