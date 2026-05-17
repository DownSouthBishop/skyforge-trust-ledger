// Telegram notification utility — shared across all Atlas edge functions

function escapeMarkdown(text: string): string {
  // Escape Telegram MarkdownV2 special characters
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

export async function sendTelegramAlert(message: string): Promise<void> {
  const token  = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");

  if (!token || !chatId) {
    console.warn("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — Telegram alerts disabled");
    return;
  }

  // Try MarkdownV2 first; fall back to plain text if that fails
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: escapeMarkdown(message), parse_mode: "MarkdownV2" }),
    });
    if (!res.ok) {
      // Fall back to plain text
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      });
    }
  } catch (e) {
    console.error("Telegram alert failed:", e);
  }
}
