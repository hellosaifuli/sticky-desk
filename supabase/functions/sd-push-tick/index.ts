// Sticky Desk notification sender. Woken every minute by pg_cron (and right away by the test button).
// Sends: queued messages, the morning "due today" note, each prayer time in Dhaka, and meeting
// reminders 30 and 5 minutes before each Google Calendar event. Reads the calendar every 5 minutes.
import webpush from "npm:web-push@3.6.7";
import * as adhan from "npm:adhan@4.4.3";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const TZ = "Asia/Dhaka";
const APP = "https://sticky-desk-ochre.vercel.app/";
const PRAYERS: [keyof adhan.PrayerTimes, string, string][] = [
  ["fajr", "ফজর", "Fajr"], ["dhuhr", "যোহর", "Dhuhr"], ["asr", "আসর", "Asr"], ["maghrib", "মাগরিব", "Maghrib"], ["isha", "এশা", "Isha"],
];

type Sub = { endpoint: string; board_id: string; p256dh: string; auth: string; prefs: { due?: boolean; prayer?: boolean; hour?: number }; fails: number };

function dhakaParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute, ymd: `${p.year}-${p.month}-${p.day}` };
}
const fmtTime = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });

async function getKeys() {
  let { data } = await sb.from("sd_push_keys").select("*").eq("id", 1).maybeSingle();
  if (!data) {
    const k = webpush.generateVAPIDKeys();
    await sb.from("sd_push_keys").insert({ id: 1, public_key: k.publicKey, private_key: k.privateKey });
    ({ data } = await sb.from("sd_push_keys").select("*").eq("id", 1).single());
  }
  return data as { public_key: string; private_key: string; tick_secret: string };
}

// Records the message first, so it goes out at most once even if two ticks overlap.
async function claim(board: string, tag: string) {
  const { error } = await sb.from("sd_push_log").insert({ board_id: board, tag });
  return !error;
}

async function send(subs: Sub[], msg: { title: string; body: string; tag: string; url?: string; kind?: string }) {
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ ...msg, url: msg.url || APP }),
        { TTL: 3600, urgency: "high" },
      );
      ok++;
      await sb.from("sd_push_subs").update({ last_ok: new Date().toISOString(), fails: 0 }).eq("endpoint", s.endpoint);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 404/410: the browser threw this subscription away, so stop sending to it
      const gone = code === 404 || code === 410 || s.fails >= 20;
      await sb.from("sd_push_subs").update(gone ? { active: false } : { fails: s.fails + 1 }).eq("endpoint", s.endpoint);
      console.log("push failed", code, String((e as Error).message).slice(0, 160));
    }
  }
  return ok;
}

/* ---------- Google Calendar ---------- */
type Google = { board_id: string; refresh_token: string; access_token: string | null; access_expires: string | null; synced_at: string | null };
const JOIN_RE = /https:\/\/(meet\.google\.com\/[a-z0-9-]+|[\w.-]*zoom\.us\/j\/[^\s"<>]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>]+)/i;

async function accessToken(g: Google) {
  if (g.access_token && g.access_expires && new Date(g.access_expires).getTime() > Date.now() + 60000) return g.access_token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: Deno.env.get("GOOGLE_CLIENT_ID") || "", client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "", refresh_token: g.refresh_token, grant_type: "refresh_token" }),
  });
  const t = await r.json();
  if (!r.ok) {
    // invalid_grant: the person revoked access or Google expired it; they need to connect again
    const msg = t.error === "invalid_grant" ? "Google sign-in expired. Connect Google Calendar again." : "Couldn't reach Google Calendar.";
    await sb.from("sd_google").update(t.error === "invalid_grant" ? { last_error: msg, active: false } : { last_error: msg }).eq("board_id", g.board_id);
    return null;
  }
  await sb.from("sd_google").update({ access_token: t.access_token, access_expires: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString() }).eq("board_id", g.board_id);
  return t.access_token as string;
}

async function syncCalendar(g: Google) {
  const token = await accessToken(g); if (!token) return;
  const from = new Date(Date.now() - 15 * 60000).toISOString(), to = new Date(Date.now() + 12 * 3600000).toISOString();
  const u = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  for (const [k, v] of Object.entries({ timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: "50" })) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) { await sb.from("sd_google").update({ last_error: "Couldn't read your calendar (" + r.status + ")." }).eq("board_id", g.board_id); return; }
  const items = ((await r.json()).items || []) as Record<string, any>[];
  const rows = items
    .filter((e) => e.status !== "cancelled" && e.start?.dateTime) // all-day events have no time to remind about
    .filter((e) => !(e.attendees || []).some((a: any) => a.self && a.responseStatus === "declined"))
    .map((e) => {
      const video = (e.conferenceData?.entryPoints || []).find((x: any) => x.entryPointType === "video")?.uri;
      const found = ((e.location || "") + " " + (e.description || "")).match(JOIN_RE)?.[0];
      return { board_id: g.board_id, event_id: String(e.id).slice(0, 200), title: String(e.summary || "Meeting").slice(0, 140), starts_at: e.start.dateTime, ends_at: e.end?.dateTime || null, join_url: e.hangoutLink || video || found || null, html_link: e.htmlLink || null, gone: false, updated_at: new Date().toISOString() };
    });
  // anything in the window that Google no longer lists was cancelled or moved away
  await sb.from("sd_events").update({ gone: true }).eq("board_id", g.board_id).gte("starts_at", from).lte("starts_at", to);
  if (rows.length) await sb.from("sd_events").upsert(rows);
  await sb.from("sd_google").update({ synced_at: new Date().toISOString(), last_error: null }).eq("board_id", g.board_id);
}

Deno.serve(async (req) => {
  const keys = await getKeys();
  const given = req.headers.get("x-tick");
  if (given !== keys.tick_secret && given !== "setup") return new Response("no", { status: 401 });
  if (given === "setup") return Response.json({ ready: true });
  webpush.setVapidDetails(APP.replace(/\/$/, ""), keys.public_key, keys.private_key);

  const { data: subRows } = await sb.from("sd_push_subs").select("endpoint, board_id, p256dh, auth, prefs, fails").eq("active", true);
  const byBoard = new Map<string, Sub[]>();
  for (const s of (subRows || []) as Sub[]) byBoard.set(s.board_id, [...(byBoard.get(s.board_id) || []), s]);
  const sent: Record<string, number> = { queued: 0, due: 0, prayer: 0, meeting: 0 };

  // 0. calendars: read every 5 minutes, and straight away for a newly connected one
  const minuteNow = new Date().getUTCMinutes();
  const { data: googles } = await sb.from("sd_google").select("board_id, refresh_token, access_token, access_expires, synced_at").eq("active", true);
  let calendars = 0;
  for (const g of (googles || []) as Google[]) {
    if (g.synced_at && minuteNow % 5 !== 0) continue;
    try { await syncCalendar(g); calendars++; } catch (e) { console.log("calendar sync failed", String((e as Error).message).slice(0, 160)); }
  }
  if (!byBoard.size) return Response.json({ boards: 0, calendars });

  // 1. queued messages (the test button)
  const { data: queue } = await sb.from("sd_push_queue").select("*").eq("sent", false).order("id").limit(50);
  for (const q of queue || []) {
    await sb.from("sd_push_queue").update({ sent: true }).eq("id", q.id);
    const subs = byBoard.get(q.board_id); if (!subs) continue;
    sent.queued += await send(subs, { title: q.title, body: q.body, tag: "test-" + q.id });
  }

  const now = new Date();
  const t = dhakaParts(now);

  // 2. prayer times, sent within five minutes of the time
  const params = adhan.CalculationMethod.Karachi();
  params.madhab = adhan.Madhab.Hanafi;
  const times = new adhan.PrayerTimes(new adhan.Coordinates(23.8103, 90.4125), new Date(t.y, t.m - 1, t.d), params);
  const dueNow = PRAYERS.filter(([k]) => { const at = times[k] as unknown as Date; const ms = now.getTime() - at.getTime(); return ms >= 0 && ms < 5 * 60000; });
  for (const [k, bn, en] of dueNow) {
    const at = times[k] as unknown as Date;
    for (const [board, subs] of byBoard) {
      const want = subs.filter((s) => s.prefs?.prayer !== false); if (!want.length) continue;
      if (!(await claim(board, `prayer:${t.ymd}:${k}`))) continue;
      sent.prayer += await send(want, { title: `${bn} · ${en} ${fmtTime(at)}`, body: `নামাজের সময় হয়েছে। It's time for ${en}.`, tag: "prayer-" + k });
    }
  }

  // 3. the morning note: what's due today or late, at each device's chosen hour
  for (const [board, subs] of byBoard) {
    const want = subs.filter((s) => s.prefs?.due !== false && (s.prefs?.hour ?? 9) === t.hour && t.minute < 15);
    if (!want.length) continue;
    const { data: rows } = await sb.from("sd_items").select("data").eq("board_id", board).eq("kind", "note").eq("deleted", false);
    const due = (rows || []).map((r) => r.data as { text?: string; column?: string; due?: string })
      .filter((n) => n.column !== "done" && n.due && n.due <= t.ymd)
      .sort((a, b) => (a.due! < b.due! ? -1 : 1));
    if (!due.length) continue;
    if (!(await claim(board, `due:${t.ymd}`))) continue;
    const late = due.filter((n) => n.due! < t.ymd).length;
    const title = `${due.length} note${due.length > 1 ? "s" : ""} due today` + (late ? ` · ${late} late` : "");
    const body = due.slice(0, 3).map((n) => "• " + (n.text || "Photo note").replace(/\s+/g, " ").slice(0, 60)).join("\n") + (due.length > 3 ? `\n+ ${due.length - 3} more` : "");
    sent.due += await send(want, { title, body, tag: "due" });
  }

  // 4. meetings: 30 and 5 minutes before they start; tapping the alert opens the call
  const { data: soon } = await sb.from("sd_events").select("board_id, event_id, title, starts_at, join_url, html_link")
    .eq("gone", false).gt("starts_at", new Date(now.getTime() + 3 * 60000).toISOString()).lte("starts_at", new Date(now.getTime() + 31 * 60000).toISOString());
  for (const e of soon || []) {
    const subs = byBoard.get(e.board_id); if (!subs) continue;
    const mins = Math.round((new Date(e.starts_at).getTime() - now.getTime()) / 60000);
    const slot = mins >= 29 ? 30 : mins <= 6 ? 5 : 0; if (!slot) continue;
    if (!(await claim(e.board_id, `meeting:${e.event_id}:${e.starts_at}:${slot}`))) continue;
    sent.meeting += await send(subs, {
      title: `${e.title} in ${slot} min`,
      body: (e.join_url ? "Tap to join · " : "") + fmtTime(new Date(e.starts_at)),
      tag: "meeting-" + e.event_id, url: e.join_url || e.html_link || APP, kind: "meeting",
    });
  }

  return Response.json({ boards: byBoard.size, calendars, sent });
});
