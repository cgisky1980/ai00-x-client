import React, { createContext, useContext, useState } from "react"
import { cn } from "@underlay/lib/utils"
import { ChevronDown } from "lucide-react"

interface AccordionContextValue {
    openItems: Set<string>
    toggleItem: (value: string) => void
}

const AccordionContext = createContext<AccordionContextValue | null>(null)

export function Accordion({ children, className }: { children: React.ReactNode, className?: string }) {
    const [openItems, setOpenItems] = useState<Set<string>>(new Set())

    const toggleItem = (value: string) => {
        setOpenItems((prev) => {
            const newSet = new Set(prev)
            if (newSet.has(value)) {
                newSet.delete(value)
            } else {
                newSet.add(value)
            }
            return newSet
        })
    }

    return (
        <AccordionContext.Provider value={{ openItems, toggleItem }}>
            <div className={cn("space-y-2", className)}>{children}</div>
        </AccordionContext.Provider>
    )
}

export function AccordionItem({
    value: _value,
    children,
    className
}: {
    value: string
    children: React.ReactNode
    className?: string
}) {
    return (
        <div className={cn("border-b border-white/10", className)}>
            {children}
        </div>
    )
}

export function AccordionTrigger({
    children,
    className
}: {
    children: React.ReactNode
    className?: string
}) {
    const context = useContext(AccordionContext)
    if (!context) throw new Error("AccordionTrigger must be used within Accordion")

    const parent = useContext(AccordionItemContext)
    if (!parent) throw new Error("AccordionTrigger must be used within AccordionItem")

    const isOpen = context.openItems.has(parent.value)

    return (
        <button
            onClick={() => context.toggleItem(parent.value)}
            className={cn(
                "flex items-center justify-between w-full py-2 px-3 text-sm font-medium transition-colors hover:bg-white/10 rounded-md text-left",
                className
            )}
        >
            {children}
            <ChevronDown
                className={cn(
                    "w-4 h-4 transition-transform duration-200",
                    isOpen && "rotate-180"
                )}
            />
        </button>
    )
}

export function AccordionContent({
    children,
    className
}: {
    children: React.ReactNode
    className?: string
}) {
    const context = useContext(AccordionContext)
    if (!context) throw new Error("AccordionContent must be used within Accordion")

    const parent = useContext(AccordionItemContext)
    if (!parent) throw new Error("AccordionContent must be used within AccordionItem")

    const isOpen = context.openItems.has(parent.value)

    if (!isOpen) return null

    return (
        <div className={cn("pb-3 px-3", className)}>
            {children}
        </div>
    )
}

const AccordionItemContext = createContext<{ value: string } | null>(null)

export function AccordionItemProvider({ value, children }: { value: string, children: React.ReactNode }) {
    return (
        <AccordionItemContext.Provider value={{ value }}>
            {children}
        </AccordionItemContext.Provider>
    )
}
