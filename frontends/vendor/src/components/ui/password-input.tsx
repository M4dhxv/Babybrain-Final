import * as React from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * A password field with an eye button that shows or hides what was typed.
 * Takes the same props as <Input>; the button sits inside the field's right
 * edge, keeps the caret in the input when pressed, and has a 44px touch area.
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, Omit<React.ComponentProps<typeof Input>, 'type'>>(
  ({ className, ...props }, ref) => {
    const [shown, setShown] = React.useState(false)
    return (
      <div className="relative">
        <Input {...props} ref={ref} type={shown ? 'text' : 'password'} className={cn('pr-12', className)} />
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          onMouseDown={(e) => e.preventDefault()}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          className="absolute right-0 top-0 grid h-full w-12 place-items-center rounded-r-md text-gray-500 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FA4D8D]"
        >
          {shown ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
        </button>
      </div>
    )
  },
)
PasswordInput.displayName = 'PasswordInput'
