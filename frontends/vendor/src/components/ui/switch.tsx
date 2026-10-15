"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-6 w-10 shrink-0 cursor-pointer items-center justify-start rounded-full p-0.5 outline-none data-[state=checked]:justify-end data-[state=checked]:bg-[#FA4D8D] data-[state=unchecked]:bg-gray-300 focus-visible:ring-[3px] focus-visible:ring-[#FA4D8D]/40 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-5 rounded-full bg-white shadow-sm"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
