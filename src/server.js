// Atlas WhatsApp botu – webhook sunucusu.
// Meta mesajı buraya POST eder; bot hemen 200 döner, işi arka planda yapar.
import express from 'express';
import fs from 'node:fs';
import { sendText, markRead, validSignature } from './whatsapp.js';
import { answer } from './agent.js';

const USERS = JSON.parse(fs.readFileSync(process.env.USERS_FILE || './users.json', 'utf8'));
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// 1) Meta webhook doğrulaması (kurulumda bir kez)
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

const seen = new Set(); // Meta aynı mesajı tekrar gönderebilir
const busy = new Map(); // aynı kişiden üst üste gelen mesajları sıraya koy

// 2) Gelen mesajlar
app.post('/webhook', (req, res) => {
  if (!validSignature(req.rawBody, req.get('X-Hub-Signature-256'))) return res.sendStatus(401);
  res.sendStatus(200); // Meta'ya hemen cevap ver, yoksa tekrar dener

  const changes = (req.body.entry || []).flatMap((e) => e.changes || []);
  for (const ch of changes) {
    for (const msg of ch.value?.messages || []) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      if (seen.size > 5000) seen.clear();
      handle(msg).catch((e) => console.error('işleme hatası', e));
    }
  }
});

async function handle(msg) {
  const phone = msg.from; // ör. 905415018100
  const user = USERS[phone];
  markRead(msg.id);

  if (!user) {
    await sendText(phone, 'Merhaba! Ben Atlas 👋 Bu hat 3M Digital ekibine özel. Erişim için Taha ile iletişime geçebilirsiniz.');
    return;
  }
  if (msg.type !== 'text') {
    await sendText(phone, 'Şimdilik sadece yazılı mesajları anlayabiliyorum 🙂 Sorunu yazar mısın?');
    return;
  }

  const prev = busy.get(phone) || Promise.resolve();
  const job = prev.then(async () => {
    // Cevap uzun sürecekse önce "bakıyorum" yaz (Taha'nın isteği)
    let acked = false;
    const timer = setTimeout(() => {
      acked = true;
      sendText(phone, 'Hemen bakıyorum ⏳');
    }, Number(process.env.ACK_AFTER_MS || 2500));
    try {
      const reply = await answer(user, phone, msg.text.body);
      clearTimeout(timer);
      await sendText(phone, reply);
    } catch (e) {
      clearTimeout(timer);
      console.error('Claude hatası', e);
      await sendText(phone, 'Şu an veriye ulaşamadım, birkaç dakika sonra tekrar dener misin? 🙏');
    }
  });
  const tail = job.finally(() => { if (busy.get(phone) === tail) busy.delete(phone); });
  busy.set(phone, tail);
}

app.get('/health', (_req, res) => res.send('ok'));
app.listen(process.env.PORT || 3000, () => console.log('Atlas dinlemede:', process.env.PORT || 3000));
