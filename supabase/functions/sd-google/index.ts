// Sticky Desk ↔ Google Calendar. The browser sends Google's one-time sign-in code here; this
// function swaps it for a long-lived key (kept only on the server) using the client secret.
// Actions: config (is Google set up?), connect, status, disconnect.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
// Google keys come from edge function secrets if set, otherwise from Supabase Vault (sd_google_keys).
let keyCache: { id: string; secret: string; at: number } | null = null;
async function googleKeys() {
  if (keyCache && Date.now() - keyCache.at < 60000) return keyCache;
  const { data } = await sb.rpc("sd_google_keys");
  keyCache = { id: Deno.env.get("GOOGLE_CLIENT_ID") || data?.client_id || "", secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || data?.client_secret || "", at: Date.now() };
  return keyCache;
}
const REDIRECT = "https://sticky-desk-ochre.vercel.app/";
const ORIGINS = ["https://sticky-desk-ochre.vercel.app", "http://localhost:8765"];

const cors = (req: Request) => {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) || o.startsWith("chrome-extension://") ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "content-type, apikey, authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};

async function boardFor(key: string) {
  if (!key) return null;
  const { data } = await sb.rpc("sd_board_for", { p_key: key });
  return (data as string) || null;
}

// Google's id_token is a JWT straight from Google over TLS; we only read the email out of it.
function emailFrom(idToken?: string) {
  try { return JSON.parse(atob(idToken!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || null; } catch { return null; }
}

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: h });
  let body: { action?: string; key?: string; code?: string } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }

  const g = await googleKeys();
  if (body.action === "config") return json({ ok: true, ready: !!(g.id && g.secret), clientId: g.id || null, redirect: REDIRECT });

  const board = await boardFor(body.key || "");
  if (!board) return json({ ok: false, error: "signed_out" }, 401);

  if (body.action === "connect") {
    if (!g.id || !g.secret) return json({ ok: false, error: "not_set_up" });
    if (!body.code || body.code.length > 600) return json({ ok: false, error: "bad_code" });
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: body.code, client_id: g.id, client_secret: g.secret, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
    });
    const t = await r.json();
    if (!r.ok || !t.refresh_token) {
      console.log("google exchange failed", r.status, t.error, t.error_description);
      return json({ ok: false, error: t.refresh_token ? "google_error" : "no_offline_access", detail: t.error_description || t.error || null });
    }
    const email = emailFrom(t.id_token);
    await sb.from("sd_google").upsert({
      board_id: board, email, refresh_token: t.refresh_token, access_token: t.access_token,
      access_expires: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(), active: true, connected_at: new Date().toISOString(), last_error: null, synced_at: null,
    });
    // pull today's meetings straight away rather than waiting for the next minute
    await sb.rpc("sd_push_kick");
    return json({ ok: true, email });
  }

  if (body.action === "status") {
    const { data } = await sb.from("sd_google").select("email, active, synced_at, last_error").eq("board_id", board).maybeSingle();
    return json({ ok: true, connected: !!data?.active, email: data?.active ? data.email : null, synced: data?.synced_at || null, error: data?.last_error || null });
  }

  if (body.action === "disconnect") {
    const { data } = await sb.from("sd_google").select("refresh_token").eq("board_id", board).maybeSingle();
    if (data?.refresh_token) await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(data.refresh_token), { method: "POST" }).catch(() => {});
    await sb.from("sd_google").update({ active: false, refresh_token: "revoked", access_token: null }).eq("board_id", board);
    await sb.from("sd_events").update({ gone: true }).eq("board_id", board);
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
