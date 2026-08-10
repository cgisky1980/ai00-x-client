import { DesktopItem } from "@underlay/desktop/types"


interface DesktopShortcutProps {
    item: DesktopItem | undefined
    path: string
    onOpen: (path: string) => void
    onMouseEnter: (rect: DOMRect, label: string) => void
    onMouseLeave: () => void
}

export function DesktopShortcut({ item, path, onOpen, onMouseEnter, onMouseLeave }: DesktopShortcutProps) {
    const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect()
        onMouseEnter(rect, (item?.name || path.split(/[/\\]/).pop() || "Unknown").replace(/\.(lnk|url)$/i, ""))
    }

    return (
        <div
            className="desktop-shortcut flex flex-col items-center justify-center w-full h-full absolute inset-0 p-1 hover:bg-white/10 rounded transition-colors group"
            onDoubleClick={() => onOpen(path)}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <img
                src={item?.icon_base64 ? `data:image/png;base64,${item.icon_base64}` : undefined}
                className="w-12 h-12 object-contain transition duration-200 group-hover:scale-110"
                draggable={false}
                alt=""
            />
            <div
                className="text-[10px] text-white text-center w-full truncate mt-1 px-1 rounded bg-black/20"
                data-label="1"
            >
                {(item?.name || path.split(/[/\\]/).pop() || "Unknown").replace(/\.(lnk|url)$/i, "")}
            </div>
        </div>
    )
}
