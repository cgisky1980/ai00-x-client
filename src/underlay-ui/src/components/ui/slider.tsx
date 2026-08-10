import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@underlay/lib/utils"

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex touch-none select-none items-center",
      props.orientation === "vertical" ? "h-full w-2 flex-col" : "w-full",
      className
    )}
    {...props}
  >
    <SliderPrimitive.Track className={cn(
      "relative grow overflow-hidden rounded-full bg-secondary",
      props.orientation === "vertical" ? "h-full w-2" : "h-2 w-full"
    )}>
      <SliderPrimitive.Range className={cn(
        "absolute bg-primary",
        props.orientation === "vertical" ? "w-full bottom-0" : "h-full"
      )} />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block h-5 w-5 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50" />
  </SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
