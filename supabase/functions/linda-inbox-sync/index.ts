// linda-inbox-sync — polls the operator's Gmail inbox via IMAP for replies to Linda's
// outbound emails. Matches replies to leads, logs them, marks linda_responses.replied_at,
// advances lead status, and drafts a suggested reply (reusing the objection playbook)
// straight into linda_responses as pending_approval — same Inbox review flow as everything
// else Linda writes. Runs every 15 min via pg_cron (see 20260704000004_linda_inbox_sync_cron.sql).
//
// This is a minimal, hand-rolled IMAP client — only LOGIN/SELECT/UID SEARCH/UID FETCH/LOGOUT,
// built specifically against Gmail. Same raw-TLS-socket approach denomailer already uses
// for SMTP in linda-send-email (confirms the platform allows direct TCP/TLS sockets).
// Any parse failure on a single message is logged and skipped — never aborts the whole poll.

import { corsHeaders, callGatewayWithRetry } from "../_shared/gateway.ts";

const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;
const MAX_MESSAGES_PER_RUN = 20;

// ── Minimal IMAP client ──────────────────────────────────────────────────────

interface ImapLine { text: string; literals: string[]; }

class ImapClient {
  private buf = new Uint8Array(0);
  private tagCounter = 0;

  constructor(private conn: Deno.TlsConn) {}

  private async fill(min: number): Promise<void> {
    while (this.buf.length < min) {
      const chunk = new Uint8Array(4096);
      const n = await this.conn.read(chunk);
      if (n === null) throw new Error("IMAP connection closed unexpectedly");
      const merged = new Uint8Array(this.buf.length + n);
      merged.set(this.buf, 0);
      merged.set(chunk.subarray(0, n), this.buf.length);
      this.buf = merged;
    }
  }

  private async writeAll(data: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < data.length) {
      offset += await this.conn.write(data.subarray(offset));
    }
  }

  private async readRawLine(): Promise<string> {
    while (true) {
      for (let i = 0; i < this.buf.length - 1; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const text = new TextDecoder("utf-8", { fatal: false }).decode(this.buf.subarray(0, i));
          this.buf = this.buf.subarray(i + 2);
          return text;
        }
      }
      await this.fill(this.buf.length + 1);
    }
  }

  private async readLiteral(n: number): Promise<Uint8Array> {
    await this.fill(n);
    const bytes = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return bytes;
  }

  private async readLogicalLine(): Promise<ImapLine> {
    const literals: string[] = [];
    let text = await this.readRawLine();
    let m: RegExpMatchArray | null;
    while ((m = text.match(/\{(\d+)\}\r?$/))) {
      const n = parseInt(m[1], 10);
      const bytes = await this.readLiteral(n);
      literals.push(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
      text = text.slice(0, m.index) + " " + (await this.readRawLine());
    }
    return { text, literals };
  }

  private nextTag(): string {
    this.tagCounter++;
    return `A${this.tagCounter}`;
  }

  async readGreeting(): Promise<void> {
    await this.readRawLine();
  }

  async command(cmd: string): Promise<{ lines: ImapLine[]; status: string }> {
    const tag = this.nextTag();
    await this.writeAll(new TextEncoder().encode(`${tag} ${cmd}\r\n`));
    const lines: ImapLine[] = [];
    while (true) {
      const line = await this.readLogicalLine();
      if (line.text.startsWith(`${tag} `)) {
        return { lines, status: line.text.slice(tag.length + 1) };
      }
      lines.push(line);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function upsertCursor(supabaseUrl: string, h: Record<string, string>, userId: string, lastUid: number): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/rpc/upsert_shared_memory`, {
    method: "POST",
    headers: { ...h, Prefer: "return=minimal" },
    body: JSON.stringify({
      _user_id: userId,
      _source_agent: "linda",
      _memory_type: "linda_imap_sync",
      _key: "imap_sync_cursor",
      _value: JSON.stringify({ last_uid: lastUid }),
    }),
  }).catch(() => {});
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let conn: Deno.TlsConn | null = null;

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const GMAIL_ADDRESS = Deno.env.get("GMAIL_ADDRESS") ?? "";
    const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
    const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

    if (!GMAIL_ADDRESS || !GMAIL_APP_PASSWORD) {
      return json({ ok: false, error: "GMAIL_ADDRESS / GMAIL_APP_PASSWORD not configured" }, 500);
    }

    const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

    // Resolve operator — same pattern as linda_pipeline
    const agentRes = await fetch(`${SUPABASE_URL}/rest/v1/skyforge_agents?select=user_id&is_active=eq.true&limit=1`, { headers: h });
    const agentRows = agentRes.ok ? (await agentRes.json() as any[]) : [];
    if (!agentRows.length) return json({ ok: false, error: "No agents found" });
    const uid = agentRows[0].user_id as string;

    // Load sync cursor
    const cursorRes = await fetch(
      `${SUPABASE_URL}/rest/v1/shared_operator_memory?user_id=eq.${uid}&source_agent=eq.linda&key=eq.imap_sync_cursor&select=value&limit=1`,
      { headers: h },
    );
    const cursorRows = cursorRes.ok ? (await cursorRes.json() as any[]) : [];
    let lastUid = 0;
    if (cursorRows.length) {
      try { lastUid = Number(JSON.parse(cursorRows[0].value)?.last_uid) || 0; } catch { /* leave 0 */ }
    }

    conn = await Deno.connectTls({ hostname: IMAP_HOST, port: IMAP_PORT });
    const imap = new ImapClient(conn);
    await imap.readGreeting();

    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const login = await imap.command(`LOGIN "${esc(GMAIL_ADDRESS)}" "${esc(GMAIL_APP_PASSWORD)}"`);
    if (!/^OK/i.test(login.status)) {
      conn.close();
      return json({ ok: false, error: `IMAP login failed: ${login.status}` }, 502);
    }

    const select = await imap.command("SELECT INBOX");
    let uidNext = 0;
    for (const l of select.lines) {
      const m = l.text.match(/UIDNEXT (\d+)/i);
      if (m) uidNext = parseInt(m[1], 10);
    }

    // First run: just baseline the cursor, don't process the entire mailbox backlog.
    if (lastUid === 0) {
      await upsertCursor(SUPABASE_URL, h, uid, Math.max(uidNext - 1, 0));
      await imap.command("LOGOUT").catch(() => {});
      conn.close();
      return json({ ok: true, first_run: true, baseline_uid: Math.max(uidNext - 1, 0), replies_processed: 0 });
    }

    if (uidNext - 1 <= lastUid) {
      await imap.command("LOGOUT").catch(() => {});
      conn.close();
      return json({ ok: true, replies_processed: 0, message: "No new mail" });
    }

    const search = await imap.command(`UID SEARCH UID ${lastUid + 1}:*`);
    const searchLine = search.lines.find((l) => l.text.startsWith("* SEARCH"));
    const uids = searchLine
      ? searchLine.text.replace("* SEARCH", "").trim().split(/\s+/).filter(Boolean).map(Number)
      : [];
    const uidsToFetch = uids.filter((n) => Number.isFinite(n) && n > 0).slice(0, MAX_MESSAGES_PER_RUN);

    let processed = 0;
    const notifyLines: string[] = [];
    let highestUidSeen = lastUid;

    if (uidsToFetch.length) {
      const fetchRes = await imap.command(
        `UID FETCH ${uidsToFetch.join(",")} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID)] BODY.PEEK[TEXT])`,
      );

      const leadsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/linda_leads?user_id=eq.${uid}&email=not.is.null&select=id,email,status,full_name`,
        { headers: h },
      );
      const leads = leadsRes.ok ? (await leadsRes.json() as any[]) : [];
      const leadByEmail = new Map(leads.map((l: any) => [String(l.email).toLowerCase().trim(), l]));

      const objRes = await fetch(
        `${SUPABASE_URL}/rest/v1/linda_objections?user_id=eq.${uid}&order=created_at.desc&limit=10&select=objection_category,objection_text,response_used,outcome`,
        { headers: h },
      );
      const objections = objRes.ok ? (await objRes.json() as any[]) : [];
      const objectionsContext = objections.length
        ? `\n\nOBJECTION PLAYBOOK (reuse what worked before):\n${objections.map((o: any) => `- [${o.objection_category ?? "other"}] "${o.objection_text}" → ${o.response_used}`).join("\n")}`
        : "";

      for (const line of fetchRes.lines) {
        try {
          if (!line.text.includes("FETCH") || line.literals.length < 2) continue;

          const uidMatch = line.text.match(/UID (\d+)/);
          const msgUid = uidMatch ? parseInt(uidMatch[1], 10) : null;
          const headerText = line.literals[0];
          const bodyText = line.literals[1].slice(0, 5000);

          const fromMatch = headerText.match(/^From:\s*(.+)$/im);
          const subjectMatch = headerText.match(/^Subject:\s*(.+)$/im);
          const msgIdMatch = headerText.match(/^Message-ID:\s*(.+)$/im);

          const fromRaw = fromMatch ? fromMatch[1].trim() : "";
          const emailMatch = fromRaw.match(/<([^>]+)>/);
          const fromEmail = (emailMatch ? emailMatch[1] : fromRaw).toLowerCase().trim();
          const subject = subjectMatch ? subjectMatch[1].trim() : "(no subject)";
          const messageId = msgIdMatch ? msgIdMatch[1].trim() : null;

          if (msgUid && msgUid > highestUidSeen) highestUidSeen = msgUid;
          if (!fromEmail) continue;

          const lead = leadByEmail.get(fromEmail);
          const matched = !!lead;

          await fetch(`${SUPABASE_URL}/rest/v1/linda_reply_log`, {
            method: "POST",
            headers: { ...h, Prefer: "return=minimal,resolution=ignore-duplicates" },
            body: JSON.stringify({
              user_id: uid, lead_id: lead?.id ?? null, from_email: fromEmail,
              subject, body: bodyText, message_id: messageId, matched,
            }),
          }).catch(() => {});

          if (!lead) { processed++; continue; }

          const respRes = await fetch(
            `${SUPABASE_URL}/rest/v1/linda_responses?user_id=eq.${uid}&lead_id=eq.${lead.id}&channel=eq.email&status=eq.sent&replied_at=is.null&order=sent_at.desc&limit=1&select=id`,
            { headers: h },
          );
          const respRows = respRes.ok ? (await respRes.json() as any[]) : [];
          if (respRows.length) {
            await fetch(`${SUPABASE_URL}/rest/v1/linda_responses?id=eq.${respRows[0].id}`, {
              method: "PATCH", headers: { ...h, Prefer: "return=minimal" },
              body: JSON.stringify({ replied_at: new Date().toISOString() }),
            }).catch(() => {});
          }

          if (["new", "nurturing", "cold"].includes(lead.status)) {
            await fetch(`${SUPABASE_URL}/rest/v1/linda_leads?id=eq.${lead.id}`, {
              method: "PATCH", headers: { ...h, Prefer: "return=minimal" },
              body: JSON.stringify({ status: "responded" }),
            }).catch(() => {});
          }

          const draftPrompt = `A lead replied to our outreach. Draft a short, warm, direct reply. Reference the objection playbook below if their message raises something similar in kind. End with exactly one clear question as the CTA. No links, no attachments.

LEAD: ${lead.full_name}
THEIR MESSAGE:
${bodyText.slice(0, 1500)}
${objectionsContext}

Format:
SUBJECT: [subject line]
---
[reply body]`;

          const draftRes = await callGatewayWithRetry({ max_tokens: 400, messages: [{ role: "user", content: draftPrompt }] }, "");
          if (draftRes.ok) {
            const dData = await draftRes.json();
            const draft: string = dData?.choices?.[0]?.message?.content ?? "";
            const subjectM = draft.match(/^SUBJECT:\s*(.+)/m);
            const draftSubject = subjectM ? subjectM[1].trim() : `Re: ${subject}`;
            const bodyStart = draft.indexOf("---");
            const draftBody = bodyStart !== -1 ? draft.slice(bodyStart + 3).trim() : draft;
            if (draftBody && draftBody.length > 20) {
              await fetch(`${SUPABASE_URL}/rest/v1/linda_responses`, {
                method: "POST", headers: { ...h, Prefer: "return=minimal" },
                body: JSON.stringify({
                  user_id: uid, lead_id: lead.id, channel: "email",
                  subject: draftSubject, body: draftBody, status: "pending_approval",
                }),
              }).catch(() => {});
              notifyLines.push(`${lead.full_name} replied — draft response ready for review`);
            }
          }

          processed++;
        } catch (e) {
          console.error("[linda-inbox-sync] error processing message:", e);
        }
      }
    }

    await upsertCursor(SUPABASE_URL, h, uid, Math.max(highestUidSeen, uidNext - 1));
    await imap.command("LOGOUT").catch(() => {});
    conn.close();
    conn = null;

    if (BOT_TOKEN && CHAT_ID && notifyLines.length) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: `👁 *Linda — Inbox Sync*\n\n${notifyLines.map((l) => `• ${l}`).join("\n")}\n\nReview in Linda's Inbox.`,
          parse_mode: "Markdown",
        }),
      }).catch(() => {});
    }

    return json({ ok: true, replies_processed: processed });
  } catch (e) {
    console.error("[linda-inbox-sync]", e);
    return json({ ok: false, error: String(e) }, 500);
  } finally {
    try { conn?.close(); } catch { /* already closed */ }
  }
});
