// WhatsApp Cloud API yardımcıları: mesaj gönderme, okundu işareti, imza doğrulama.
import crypto from 'node:crypto';

const API = () => `https://graph.facebook.com/${process.env.WA_API_VERSION || 'v26.0'}`;

export async function sendText(to, body) {
  // WhatsApp tek mesajda 4096 karakter kabul eder; uzun cevapları böl.
  const parts = [];
  let rest = body;
  while (rest.length > 3800) {
    let cut = rest.lastIndexOf('\n', 3800);
    if (cut < 1000) cut = 3800;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  for (const p of parts) {
    const res = await fetch(`${API()}/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: p },
      }),
    });
    if (!res.ok) console.error('WhatsApp gönderim hatası', res.status, await res.text());
  }
}

export async function markRead(messageId) {
  try {
    await fetch(`${API()}/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    });
  } catch (e) {
    console.error('okundu işareti hatası', e.message);
  }
}

// Meta, her webhook isteğini App Secret ile imzalar (X-Hub-Signature-256).
export function validSignature(rawBody, header) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) return true; // geliştirme ortamı; canlıda mutlaka doldurun
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
