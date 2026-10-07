import { useState, type InputHTMLAttributes } from "react";

/**
 * A password field with an eye button that shows or hides what was typed.
 * Takes the same props as an <input> (className goes on the input itself); the
 * button sits inside the field's right edge. Pressing it keeps focus and the
 * caret in the input, and has a 44px touch area.
 */
export function PasswordInput({ className = "", ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={shown ? "text" : "password"} className={`${className} pr-12`} />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        // Keep the caret where it is instead of the button taking focus on press.
        onMouseDown={(e) => e.preventDefault()}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        className="absolute right-0 top-0 grid h-full w-12 place-items-center rounded-r-[10px] text-[#6D748A] hover:text-baby-pink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-baby-cta"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {shown ? (
            <>
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <path d="M1 1l22 22" />
            </>
          ) : (
            <>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </>
          )}
        </svg>
      </button>
    </div>
  );
}
