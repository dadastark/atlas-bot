// Atlas WhatsApp botu – webhook sunucusu.
// Meta mesajı buraya POST eder; bot hemen 200 döner, işi arka planda yapar.
import express from 'express';
import fs from 'node:fs';
import { sendText, markRead, validSignature } from './whatsapp.js';
import { answer } from './agent.js';
import { veriAl, bekleyenleriAl } from './data.js';

const USERS = JSON.parse(fs.readFileSync(process.env.USERS_FILE || './users.json', 'utf8'));
const app = express();
app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

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
  console.log('webhook geldi:', JSON.stringify(req.body).slice(0, 400));
  if (!validSignature(req.rawBody, req.get('X-Hub-Signature-256'))) return res.sendStatus(401);
  res.sendStatus(200); // Meta'ya hemen cevap ver, yoksa tekrar dener

  const changes = (req.body.entry || []).flatMap((e) => e.changes || []);
  for (const ch of changes) {
    for (const msg of ch.value?.messages || []) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      if (seen.size > 5000) seen.clear();
      handle(msg, ch.value.contacts || []).catch((e) => console.error('işleme hatası', e));
    }
  }
});

async function handle(msg, contacts = []) {
  // Meta kullanıcı adı olan kişilerde numara yerine BSUID (ör. TR.123...) gönderir
  const c = contacts[0] || {};
  const uname = String(c.profile?.username || c.username || '').replace(/^@/, '');
  const phone = msg.from || msg.from_user_id || c.user_id;
  const user = USERS[msg.from] || USERS[msg.from_user_id] || USERS[c.user_id] || (uname ? USERS['@' + uname] : undefined);
  if (!user) console.log('tanimsiz kisi:', JSON.stringify({ from: msg.from, user_id: msg.from_user_id || c.user_id, username: uname }));
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

// Teşhis: Meta tarafındaki numara ve abonelik durumunu gösterir (token gösterilmez)
app.get('/teshis', async (req, res) => {
  if (req.query.k !== process.env.WA_VERIFY_TOKEN) return res.sendStatus(403);
  const v = process.env.WA_API_VERSION || 'v26.0';
  const H = { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN };
  const get = async (p) => { try { return await (await fetch('https://graph.facebook.com/' + v + '/' + p, { headers: H })).json(); } catch (e) { return { hata: e.message }; } };
  const phone = await get(process.env.WA_PHONE_NUMBER_ID + '?fields=display_phone_number,verified_name,name_status,status,code_verification_status,quality_rating,platform_type,webhook_configuration');
  const waba = req.query.waba ? await get(req.query.waba + '/subscribed_apps') : null;
  res.json({ phone, waba });
});

// Atlas görevi (Taha'nın bilgisayarında, IRIS/Mantis açıkken) veriyi buraya gönderir
app.use('/veri', (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Atlas-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (!process.env.INGEST_KEY || req.get('X-Atlas-Key') !== process.env.INGEST_KEY) return res.sendStatus(403);
  next();
});
app.post('/veri', (req, res) => res.json(veriAl(req.body || {})));
app.get('/veri/bekleyen', (_req, res) => res.json(bekleyenleriAl()));

// Grup köprüsü: Taha'nın bilgisayarındaki WhatsApp Web sekmesi, grupta Atlas'a yazılan mesajı buraya yollar
const grupSira = { p: Promise.resolve() };
app.use('/grup', (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Atlas-Key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (!process.env.INGEST_KEY || req.get('X-Atlas-Key') !== process.env.INGEST_KEY) return res.sendStatus(403);
  next();
});
app.post('/grup', async (req, res) => {
  const { gonderen = '', text = '', alinti = '' } = req.body || {};
  const ad = String(gonderen).replace(/^[~@\s]+/, '').toLowerCase();
  const tr = (x) => x.toLocaleLowerCase('tr');
  let user = Object.values(USERS).find((u) => ad && (tr(u.name) === tr(ad) || tr(ad).startsWith(tr(u.name)) || tr(ad).includes(tr(u.name))));
  if (!user) user = { name: gonderen || 'Ekip üyesi', role: 'agent' };
  const gUser = { ...user, role: user.role === 'admin' ? 'manager' : user.role };
  const soru = (alinti ? `(Alıntıladığı mesaj: "${String(alinti).slice(0, 500)}")\n` : '') + String(text).slice(0, 2000);
  const job = grupSira.p.then(() => answer(gUser, 'grup', `${user.name}: ${soru}`, true));
  grupSira.p = job.catch(() => {});
  try { res.json({ reply: await job }); }
  catch (e) { console.error('grup hatası', e); res.status(500).json({ reply: '' }); }
});

app.get('/health', (_req, res) => res.send('ok'));

// Meta'nın istediği gizlilik politikası sayfası
app.get(['/gizlilik', '/privacy'], (_req, res) => res.type('html').send(`<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atlas – Gizlilik Politikası</title>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.6">
<h1>Atlas – Gizlilik Politikası</h1>
<p>Atlas, 3M Digital çağrı merkezi ekibinin iç kullanımı için çalışan bir WhatsApp asistanıdır. Yalnızca yetkilendirilmiş ekip üyeleriyle yazışır.</p>
<h2>Toplanan veriler</h2>
<p>Bota gönderilen mesaj metni, gönderenin WhatsApp numarası ve mesaj zamanı. Bu veriler yalnızca soruya cevap vermek için kullanılır.</p>
<h2>Kullanım ve paylaşım</h2>
<p>Mesajlar cevap üretmek için WhatsApp Cloud API (Meta) ve yapay zekâ hizmet sağlayıcısı (Anthropic) üzerinden işlenir. Veriler satılmaz, reklam amacıyla kullanılmaz ve üçüncü kişilerle paylaşılmaz.</p>
<h2>Saklama</h2>
<p>Sohbet geçmişi yalnızca sunucu belleğinde kısa süreli tutulur; sunucu yeniden başladığında silinir. Kalıcı bir mesaj arşivi tutulmaz.</p>
<h2>Haklarınız ve iletişim</h2>
<p>Verilerinizle ilgili soru veya silme talepleriniz için 3M Digital yönetimiyle iletişime geçebilirsiniz.</p>
<p><small>Son güncelleme: 15 Kasım 2026</small></p></body></html>`));
app.listen(process.env.PORT || 3000, () => console.log('Atlas dinlemede:', process.env.PORT || 3000));
