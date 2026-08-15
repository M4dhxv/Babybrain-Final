/** Printable schedule of a parent's bookings ("export bookings in PDF calendar
 *  view", from the founder QA round).
 *
 *  Rather than pull in a PDF library, this opens a clean, print-styled window
 *  and triggers the browser's print dialog — every browser offers "Save as
 *  PDF" there, and the output stays crisp and selectable. Nothing leaves the
 *  device.
 */

export interface ScheduleEntry {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  venue?: string;
  child?: string;
  status?: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

const sgLong = (iso: string) =>
  new Date(iso).toLocaleDateString("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

const sgClock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "numeric",
    minute: "2-digit",
  });

/** Inclusive ISO (yyyy-mm-dd) bounds, interpreted in Singapore time. */
export interface DateRange {
  from?: string | null;
  to?: string | null;
}

/** Keep only the entries falling inside an inclusive SGT day range. */
export function withinRange<T extends { startsAt: string }>(entries: T[], range?: DateRange): T[] {
  if (!range?.from && !range?.to) return entries;
  const fromMs = range?.from ? Date.parse(`${range.from}T00:00:00+08:00`) : -Infinity;
  // `to` is inclusive, so run to the last millisecond of that Singapore day.
  const toMs = range?.to ? Date.parse(`${range.to}T23:59:59.999+08:00`) : Infinity;
  return entries.filter((e) => {
    const t = Date.parse(e.startsAt);
    return t >= fromMs && t <= toMs;
  });
}

const sgShort = (iso: string) =>
  new Date(`${iso}T00:00:00+08:00`).toLocaleDateString("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** Human label for the chosen range, shown under the PDF's title. */
export function rangeLabel(range?: DateRange): string {
  if (range?.from && range?.to) return `${sgShort(range.from)} – ${sgShort(range.to)}`;
  if (range?.from) return `From ${sgShort(range.from)}`;
  if (range?.to) return `Up to ${sgShort(range.to)}`;
  return "All booked activities";
}

export function downloadSchedulePdf(entries: ScheduleEntry[], parentName?: string, range?: DateRange) {
  const sorted = [...withinRange(entries, range)].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)
  );

  // Group by day so it reads like a calendar rather than a flat list.
  const byDay = new Map<string, ScheduleEntry[]>();
  for (const e of sorted) {
    const day = sgLong(e.startsAt);
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }

  const days = [...byDay.entries()]
    .map(
      ([day, items]) => `
      <section class="day">
        <h2>${esc(day)}</h2>
        ${items
          .map(
            (e) => `
          <div class="slot">
            <div class="time">${esc(sgClock(e.startsAt))}${e.endsAt ? `–${esc(sgClock(e.endsAt))}` : ""}</div>
            <div>
              <div class="title">${esc(e.title)}</div>
              ${e.venue ? `<div class="meta">${esc(e.venue)}</div>` : ""}
              ${e.child ? `<div class="meta">For ${esc(e.child)}</div>` : ""}
            </div>
            ${e.status ? `<div class="status">${esc(e.status)}</div>` : ""}
          </div>`
          )
          .join("")}
      </section>`
    )
    .join("");

  const generated = new Date().toLocaleDateString("en-SG", { timeZone: "Asia/Singapore", day: "numeric", month: "long", year: "numeric" });

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>BabyBrain schedule${parentName ? ` — ${esc(parentName)}` : ""}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; font-family: "Helvetica Neue", Arial, sans-serif; color: #1c2b61; }
  header { border-bottom: 3px solid #D9004A; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { margin: 0; font-size: 24px; }
  .sub { margin-top: 4px; font-size: 13px; color: #68718f; }
  .day { break-inside: avoid; margin-bottom: 18px; }
  .day h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #7D4AC5; margin: 0 0 8px; }
  .slot { display: grid; grid-template-columns: 110px 1fr auto; gap: 12px; align-items: baseline;
          border: 1px solid #EBE3E5; border-radius: 8px; padding: 10px 12px; margin-bottom: 6px; }
  .time { font-weight: 700; font-size: 13px; color: #D9004A; }
  .title { font-weight: 700; font-size: 15px; }
  .meta { font-size: 12px; color: #59658d; margin-top: 2px; }
  .status { font-size: 11px; text-transform: capitalize; color: #68718f; }
  footer { margin-top: 24px; border-top: 1px solid #EBE3E5; padding-top: 10px; font-size: 11px; color: #59658d; }
  @media print { body { padding: 0; } @page { margin: 16mm; } }
</style></head>
<body>
  <header>
    <h1>Class schedule${parentName ? ` — ${esc(parentName)}` : ""}</h1>
    <div class="sub">${esc(rangeLabel(range))} · ${sorted.length} ${sorted.length === 1 ? "class" : "classes"} · generated ${esc(generated)} · babybrain.sg</div>
  </header>
  ${days || '<p class="meta">No upcoming classes.</p>'}
  <footer>Share this with grandparents and helpers so everyone knows where to be.</footer>
</body></html>`;

  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) {
    alert("Please allow pop-ups for babybrain.sg to download your schedule.");
    return;
  }
  win.document.write(html);
  win.document.close();
  // Give the new document a tick to lay out before the print dialog opens.
  win.addEventListener("load", () => {
    win.focus();
    win.print();
  });
}
