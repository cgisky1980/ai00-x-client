import { motion } from "framer-motion"
import { useEffect, useState } from "react"

interface IconTooltipProps {
    x: number
    y: number
    label: string
}

/** 桌面图标悬浮标签（framer-motion 浮动提示，样式走 tooltip token） */
export function IconTooltip({ x, y, label }: IconTooltipProps) {
    // Random tilt and shake values for idle animation
    const [randomTilt, setRandomTilt] = useState(0)

    useEffect(() => {
        // Set a random initial tilt direction
        setRandomTilt(Math.random() > 0.5 ? 5 : -5)
    }, [])

    return (
        <motion.div
            className="fixed pointer-events-none"
            style={{
                left: x,
                top: y,
                // Center horizontally relative to the point
                x: "-50%",
                // Position above the point
                y: "-100%"
            }}
            initial={{ scale: 0, opacity: 0, rotate: 0 }}
            animate={{
                scale: 1,
                opacity: 1,
                rotate: [0, randomTilt, -randomTilt, randomTilt / 2, 0],
            }}
            transition={{
                scale: { type: "spring", stiffness: 300, damping: 20 },
                opacity: { duration: 0.2 },
                rotate: {
                    repeat: Infinity,
                    repeatType: "mirror",
                    duration: 2,
                    ease: "easeInOut"
                }
            }}
        >
            <div
                className="relative text-xs px-3 py-1.5 rounded-md shadow-lg whitespace-nowrap mb-2"
                style={{
                    background: "var(--tooltip-bg)",
                    border: "1px solid var(--tooltip-border)",
                    color: "var(--tooltip-text)",
                }}
            >
                {label}
                {/* Little triangle arrow at the bottom */}
                <div
                    className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[6px]"
                    style={{ borderTopColor: "var(--tooltip-bg)" }}
                />
            </div>
        </motion.div>
    )
}
