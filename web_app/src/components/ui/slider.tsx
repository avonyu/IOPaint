import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@/lib/utils"

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, orientation = "horizontal", ...props }, ref) => {
  const isVertical = orientation === "vertical"
  return (
    <SliderPrimitive.Root
      ref={ref}
      orientation={orientation}
      className={cn(
        "relative flex touch-none select-none items-center",
        isVertical ? "h-full w-4 flex-col" : "w-full",
        className
      )}
      tabIndex={-1}
      {...props}
    >
      <SliderPrimitive.Track
        className={cn(
          "relative grow overflow-hidden rounded-full bg-primary/20 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
          isVertical ? "h-full w-1.5" : "h-1.5 w-full"
        )}
      >
        <SliderPrimitive.Range
          className={cn(
            "absolute bg-primary data-[disabled]:cursor-not-allowed",
            isVertical ? "w-full" : "h-full"
          )}
        />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        tabIndex={-1}
        className="block h-4 w-4 rounded-full border border-primary/60 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[disabled]:cursor-not-allowed"
      />
    </SliderPrimitive.Root>
  )
})
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
