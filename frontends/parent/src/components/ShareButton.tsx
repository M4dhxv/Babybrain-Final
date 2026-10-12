import { useEffect, useRef, useState } from "react";
import { Button, Icon } from "./ui";
import { canShare, share } from "../lib/share";

/** Copies text where the Clipboard API is missing or refused (older browsers, http). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Shares a link. Phones and tablets open the device's own share sheet, so the
 *  parent picks WhatsApp, Instagram, Telegram, Signal, Mail, Bluetooth…
 *  themselves. Most desktops have no share sheet, so there the link is copied
 *  and the button says so. `navigator.share` is called straight from the tap,
 *  with nothing awaited first, or Safari refuses to open it. */
export function ShareButton({
  url,
  title,
  text,
  label,
  size = "md",
  className = "",
}: {
  /** Absolute URL, or a path that is resolved against this site. */
  url: string;
  title?: string;
  text?: string;
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function flash(message: string) {
    setNote(message);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), 2500);
  }

  function onClick() {
    const href = new URL(url, window.location.origin).toString();
    if (canShare()) {
      void share({ url: href, ...(title ? { title } : {}), ...(text ? { text } : {}) }).then((ok) => {
        if (!ok) void copyText(href).then((copied) => flash(copied ? "Link copied" : "Couldn't share. Please copy the address from your browser."));
      });
      return;
    }
    void copyText(href).then((copied) => flash(copied ? "Link copied" : "Couldn't copy. Please copy the address from your browser."));
  }

  return (
    <>
      <Button type="button" variant="share" size={size} onClick={onClick} className={className}>
        <Icon name="share" className="h-4 w-4" /> {label}
      </Button>
      <span role="status" aria-live="polite" className={note ? "w-full text-xs font-bold text-[#6D7486]" : "sr-only"}>
        {note}
      </span>
    </>
  );
}
