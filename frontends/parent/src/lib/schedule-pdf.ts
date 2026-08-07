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

export function downloadSchedulePdf(entries: ScheduleEntry[], parentName?: string) {
  const sorted = [...entries].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

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
  header { border-bottom: 3px solid #FA5D93; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { margin: 0; font-size: 24px; }
  .sub { margin-top: 4px; font-size: 13px; color: #68718f; }
  .day { break-inside: avoid; margin-bottom: 18px; }
  .day h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #7a5cc8; margin: 0 0 8px; }
  .slot { display: grid; grid-template-columns: 110px 1fr auto; gap: 12px; align-items: baseline;
          border: 1px solid #e7ebf6; border-radius: 8px; padding: 10px 12px; margin-bottom: 6px; }
  .time { font-weight: 700; font-size: 13px; color: #FA5D93; }
  .title { font-weight: 700; font-size: 15px; }
  .meta { font-size: 12px; color: #59658d; margin-top: 2px; }
  .status { font-size: 11px; text-transform: capitalize; color: #68718f; }
  footer { margin-top: 24px; border-top: 1px solid #e7ebf6; padding-top: 10px; font-size: 11px; color: #9aa4c2; }
  @media print { body { padding: 0; } @page { margin: 16mm; } }
</style></head>
<body>
  <header>
    <h1>Class schedule${parentName ? ` — ${esc(parentName)}` : ""}</h1>
    <div class="sub">${sorted.length} ${sorted.length === 1 ? "class" : "classes"} · generated ${esc(generated)} · babybrain.sg</div>
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
