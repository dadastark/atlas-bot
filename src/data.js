// Veri katmanı: "Atlas Veri" Google E-Tablosu ve iptal takip tablosu.
// Bot IRIS / Mantis'e doğrudan bağlanmaz. Bu tabloları, Taha'nın bilgisayarındaki
// Atlas zamanlanmış görevleri IRIS ve Mantis'ten saat başı günceller.
// Yetki kuralları burada uygulanır: model kendisine verilmeyen veriyi göremez.
import { google } from 'googleapis';
import fs from 'node:fs';

let sheetsClient;
function sheets() {
  if (!sheetsClient) {
    const creds = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return sheetsClient;
}

const cache = new Map(); // 60 sn önbellek: aynı dakikada gelen sorular tabloyu tekrar okumasın
async function readTab(sheetId, tab) {
  const key = sheetId + '|' + tab;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 60_000) return hit.rows;
  const res = await sheets().spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tab}'` });
  const [header = [], ...rows] = res.data.values || [];
  const objs = rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  cache.set(key, { t: Date.now(), rows: objs });
  return objs;
}

const tr = (s) => String(s || '').toLocaleLowerCase('tr');
const canSeeAll = (u) => u.role === 'admin' || u.role === 'manager';

// --- Araçlar (Claude'un çağırabileceği fonksiyonlar) ---

// Atlas Veri > "Gunluk" sekmesi: Tarih | Personel | Talep | Acilan | Acik | Iptal
export async function gunlukPerformans(user, { baslangic, bitis, personel }) {
  let rows = await readTab(process.env.DATA_SHEET_ID, 'Gunluk');
  rows = rows.filter((r) => (!baslangic || r.Tarih >= baslangic) && (!bitis || r.Tarih <= bitis));
  if (!canSeeAll(user)) rows = rows.filter((r) => tr(r.Personel) === tr(user.name));
  else if (personel) rows = rows.filter((r) => tr(r.Personel) === tr(personel));
  return rows;
}

// Atlas Veri > "Mantis" sekmesi: Tarih | Personel | Logon | Konusma | Bekleme | Mola | Cagri | OrtGorusme | Satis
export async function mantisRaporu(user, { baslangic, bitis, personel }) {
  let rows = await readTab(process.env.DATA_SHEET_ID, 'Mantis');
  rows = rows.filter((r) => (!baslangic || r.Tarih >= baslangic) && (!bitis || r.Tarih <= bitis));
  if (!canSeeAll(user)) rows = rows.filter((r) => tr(r.Personel) === tr(user.name));
  else if (personel) rows = rows.filter((r) => tr(r.Personel) === tr(personel));
  return rows;
}

// Atlas Veri > "Hakedis" sekmesi: Tarih | Personel | Aktif | TL  (sadece admin)
export async function hakedis(user, { baslangic, bitis, personel }) {
  if (user.role !== 'admin') return { hata: 'Hakediş bilgisini sadece Taha görebilir.' };
  let rows = await readTab(process.env.DATA_SHEET_ID, 'Hakedis');
  rows = rows.filter((r) => (!baslangic || r.Tarih >= baslangic) && (!bitis || r.Tarih <= bitis));
  if (personel) rows = rows.filter((r) => tr(r.Personel) === tr(personel));
  return rows;
}

// İptal takip tablosu: her personelin kendi sekmesi. Personel yalnızca kendi listesini görür.
export async function iptalListesi(user, { personel, sadeceAranmamis }) {
  const kim = canSeeAll(user) ? personel || user.name : user.name;
  if (user.role === 'backoffice' && !personel) {
    return { hata: 'Hangi personelin listesini istediğini belirt (ör. "Damla\'nın aranmamış iptalleri").' };
  }
  const tab = user.role === 'backoffice' ? personel : kim;
  let values;
  try {
    const res = await sheets().spreadsheets.values.get({ spreadsheetId: process.env.IPTAL_SHEET_ID, range: `'${tab}'!A1:L300` });
    values = res.data.values || [];
  } catch {
    return { hata: `"${tab}" adında bir sekme bulunamadı.` };
  }
  // Sekmelerde ilk 2 satır başlık/açıklama; sütun başlıkları 3. satırda.
  const header = values[2] || [];
  const data = values.slice(3).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  let out = data.filter((r) => r['Müşteri adı soyadı']);
  if (sadeceAranmamis) out = out.filter((r) => !r['Arama tarihi']);
  return out;
}

// Sonuç yazma: personel kendi listesindeki bir müşterinin arama sonucunu işler.
export async function iptalSonucYaz(user, { talepId, sonuc, ulasildi, not }) {
  const tab = canSeeAll(user) ? null : user.name;
  const tabs = tab ? [tab] : ['Damla', 'Buse', 'Betül', 'İrem', 'Zeynep', 'Hatice', 'Atanmamış'];
  const izinli = ['Kurtarıldı', 'Tekrar aranacak', 'Kesin vazgeçti', 'Başka firmaya geçmiş', 'Ulaşılamadı'];
  if (!izinli.includes(sonuc)) return { hata: `Sonuç şunlardan biri olmalı: ${izinli.join(', ')}` };
  for (const t of tabs) {
    const res = await sheets().spreadsheets.values.get({ spreadsheetId: process.env.IPTAL_SHEET_ID, range: `'${t}'!E1:E200` });
    const col = (res.data.values || []).map((r) => r[0]);
    const idx = col.findIndex((v) => String(v) === String(talepId));
    if (idx >= 0) {
      const row = idx + 1;
      const bugun = new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' });
      await sheets().spreadsheets.values.update({
        spreadsheetId: process.env.IPTAL_SHEET_ID,
        range: `'${t}'!I${row}:L${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[bugun, ulasildi ? 'Evet' : 'Hayır', sonuc, not || '']] },
      });
      cache.delete(process.env.IPTAL_SHEET_ID + '|' + t);
      return { tamam: true, sekme: t, satir: row };
    }
  }
  return { hata: 'Bu talep ID senin iptal listende bulunamadı.' };
}

export async function sonGuncelleme() {
  try {
    const rows = await readTab(process.env.DATA_SHEET_ID, 'Bilgi');
    return rows[0] || {};
  } catch {
    return {};
  }
}
