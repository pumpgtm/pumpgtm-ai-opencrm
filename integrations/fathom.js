#!/usr/bin/env node
// Fathom -> CRM. Logs every recorded call as a Meeting activity and every external attendee as a
// person. Idempotent: the Fathom recording id is the dedup key, so run it as often as you like.
// Never sets a stage or account notes; that stays a human (or agent) decision after reading the call.
//
//   FATHOM_API_KEY=... node integrations/fathom.js [--since=YYYY-MM-DD]
//
// Copy this file to add another source (Granola, Gmail, Calendar): fetch, then logActivity + upsertPerson.

const crm = require("../crm");

async function* meetings(since) {
  let cursor;
  for (;;) {
    const url = new URL("https://api.fathom.ai/external/v1/meetings");
    url.searchParams.set("include_summary", "true");
    if (since) url.searchParams.set("created_after", `${since}T00:00:00Z`);
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { "X-Api-Key": process.env.FATHOM_API_KEY } });
    if (res.status === 429) {
      const wait = Number(res.headers.get("ratelimit-reset") || res.headers.get("retry-after") || 60);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Fathom ${res.status}: ${await res.text()}`);
    const page = await res.json();
    yield* page.items;
    if (!(cursor = page.next_cursor)) return;
  }
}

async function main() {
  if (!process.env.FATHOM_API_KEY) throw new Error("set FATHOM_API_KEY (Fathom > Settings > API Access)");
  const since = (process.argv.find((a) => a.startsWith("--since=")) || "").slice(8) || undefined;
  let logged = 0, existed = 0;
  for await (const m of meetings(since)) {
    const external = (m.calendar_invitees || []).filter((i) => i.is_external && i.email);
    const account = external.map((i) => crm.accountForEmail(i.email)).find(Boolean);
    for (const i of external) {
      const known = crm.all("people").some((p) => p.email === i.email.toLowerCase());
      crm.upsertPerson(i.email, known ? {} : { name: i.name || i.email, account: account && account.name });
    }
    const r = crm.logActivity(m.meeting_title || m.title, {
      date: (m.recording_start_time || m.scheduled_start_time || m.created_at).slice(0, 10),
      type: "Meeting",
      account: account ? account.name : undefined,
      attendees: external.map((i) => i.email.toLowerCase()),
      source: "fathom",
      source_id: String(m.recording_id),
      url: m.share_url || m.url,
      note: m.default_summary && m.default_summary.markdown_formatted,
    });
    r.skipped ? existed++ : logged++;
  }
  console.log(`fathom: ${logged} logged, ${existed} already in the CRM`);
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
