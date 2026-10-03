/** Schedule of a parent's bookings ("export bookings in PDF calendar view",
 *  from the founder QA round).
 *
 *  Builds a real text-based PDF on the device with jsPDF (loaded on demand)
 *  and downloads it as a file. This used to open the browser's print dialog
 *  from a hidden iframe, which on Android showed a print preview instead of
 *  downloading, did nothing on iOS, and printed a screenshot-like page rather
 *  than a document. Nothing leaves the device. QA 03/10.
 */

import { canShareFile } from "./share";

export interface ScheduleEntry {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  venue?: string;
  child?: string;
  status?: string;
}

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

const PDF_NAME = "babybrain-schedule.pdf";

async function buildSchedulePdf(entries: ScheduleEntry[], parentName?: string, range?: DateRange): Promise<Blob> {
  const sorted = [...withinRange(entries, range)].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)
  );
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  const W = 210, H = 297, M = 16, R = W - M;
  const NAVY: [number, number, number] = [28, 43, 97];
  const GREY: [number, number, number] = [89, 101, 141];
  const PINK: [number, number, number] = [250, 77, 141];
  const LINE: [number, number, number] = [235, 227, 229];
  let y = M;

  const need = (h: number) => {
    if (y + h > H - M) { doc.addPage(); y = M; }
  };

  const generated = new Date().toLocaleDateString("en-SG", { timeZone: "Asia/Singapore", day: "numeric", month: "long", year: "numeric" });

  doc.setTextColor(...NAVY);
  doc.setFont("helvetica", "bold").setFontSize(20);
  doc.text(`Session schedule${parentName ? ` - ${parentName}` : ""}`, M, y + 6);
  y += 11;
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(...GREY);
  doc.text(
    `${rangeLabel(range)}  |  ${sorted.length} ${sorted.length === 1 ? "session" : "sessions"}  |  generated ${generated}  |  babybrain.sg`,
    M, y + 3
  );
  y += 7;
  doc.setDrawColor(...PINK).setLineWidth(0.8).line(M, y, R, y);
  y += 8;

  if (sorted.length === 0) {
    doc.setFontSize(11).text("No upcoming sessions.", M, y);
  }

  let lastDay = "";
  for (const e of sorted) {
    const day = sgLong(e.startsAt);
    const time = `${sgClock(e.startsAt)}${e.endsAt ? ` - ${sgClock(e.endsAt)}` : ""}`;
    const titleLines: string[] = doc.setFont("helvetica", "bold").setFontSize(11).splitTextToSize(e.title, 100);
    const meta = [e.venue, e.child ? `For ${e.child}` : ""].filter(Boolean) as string[];
    const metaLines: string[] = meta.flatMap((m) => doc.setFont("helvetica", "normal").setFontSize(9).splitTextToSize(m, 100));
    const boxH = 6 + titleLines.length * 5 + metaLines.length * 4;

    if (day !== lastDay) {
      need(10 + boxH);
      doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(...PINK);
      doc.text(day.toUpperCase(), M, y);
      y += 5;
      lastDay = day;
    } else {
      need(boxH + 2);
    }

    doc.setDrawColor(...LINE).setLineWidth(0.3).roundedRect(M, y, R - M, boxH, 2, 2);
    doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(...PINK);
    doc.text(time, M + 4, y + 6);
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...NAVY);
    doc.text(titleLines, M + 48, y + 6);
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...GREY);
    doc.text(metaLines, M + 48, y + 6 + titleLines.length * 5 - 1);
    if (e.status) {
      doc.setFontSize(9).text(e.status.charAt(0).toUpperCase() + e.status.slice(1), R - 4, y + 6, { align: "right" });
    }
    y += boxH + 3;
  }

  need(14);
  y += 4;
  doc.setDrawColor(...LINE).setLineWidth(0.3).line(M, y, R, y);
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...GREY);
  doc.text("Share this with grandparents and helpers so everyone knows where to be.", M, y + 6);

  return doc.output("blob");
}

/** Whether "Share" can be offered for the schedule PDF on this device. */
export function canShareSchedulePdf(): boolean {
  return canShareFile(new File([], PDF_NAME, { type: "application/pdf" }));
}

/** The schedule as a ready-made PDF file, for the share sheet. Built ahead of
 *  the tap (see ExportScheduleBox): `navigator.share` must be called while the
 *  tap is still "live", and building the PDF first (a chunk load plus the
 *  render) can outlast that on a phone, after which the browser refuses to
 *  open the sheet at all. */
export async function buildSchedulePdfFile(entries: ScheduleEntry[], parentName?: string, range?: DateRange): Promise<File> {
  const blob = await buildSchedulePdf(entries, parentName, range);
  return new File([blob], PDF_NAME, { type: "application/pdf", lastModified: Date.now() });
}

/** Opens the phone's share sheet (WhatsApp, Mail, AirDrop, Save to Files) for
 *  an already-built file. Call it straight from the tap handler, with nothing
 *  awaited before it. Returns null on success or when the parent just closed
 *  the sheet; otherwise the browser's reason, after saving the file instead. */
export async function shareSchedulePdfFile(file: File): Promise<string | null> {
  try {
    await navigator.share({ files: [file] });
    return null;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    saveBlob(file);
    return e instanceof Error ? `${e.name}: ${e.message}` : "unknown error";
  }
}

export async function downloadSchedulePdf(entries: ScheduleEntry[], parentName?: string, range?: DateRange) {
  saveBlob(await buildSchedulePdf(entries, parentName, range));
}

// Anchor + blob download: saves straight to Downloads on Android and
// Files on iOS Safari (13+), with no print dialog involved.
function saveBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = PDF_NAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
