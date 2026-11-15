// Veri katmanı. Bot IRIS / Mantis'e doğrudan giremez (ikisi de Taha'nın bilgisayarındaki
// oturumla açılıyor). Taha'nın bilgisayarındaki Atlas zamanlanmış görevi mesai boyunca
// saat başı IRIS ve Mantis verisini çekip POST /veri ile buraya gönderir.
// Yetki kuralları burada uygulanır: model kendisine verilmeyen veriyi göremez.
import fs from 'node:fs';

const FILE = process.env.DATA_FILE || '/tmp/atlas-veri.json';
let store = { guncelleme: null, gunluk: [], mantis: [], hakedis: [], iptal: [] };
let bekleyen = []; // personelin bota bildirdiği iptal arama sonuçları (görev tabloya işler)

try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  store = { ...store, ...saved.store };
  bekleyen = saved.bekleyen || [];
} catch { /* ilk açılış */ }

function kaydet() {
  try { fs.writeFileSync(FILE, JSON.stringify({ store, bekleyen })); } catch (e) { console.error('veri kaydedilemedi', e.message); }
}

// POST /veri gövdesi: { guncelleme, gunluk?, mantis?, hakedis?, iptal? }
// Gönderilen her liste, aynı tarihlerdeki eski satırların yerine geçer (iptal listesi tamamen değişir).
export function veriAl(body) {
  const ozet = {};
  for (const k of ['gunluk', 'mantis', 'hakedis']) {
    if (!Array.isArray(body[k])) continue;
    const tarihler = new Set(body[k].map((r) => r.Tarih));
    store[k] = store[k].filter((r) => !tarihler.has(r.Tarih)).concat(body[k]);
    ozet[k] = body[k].length;
  }
  if (Array.isArray(body.iptal)) { store.iptal = body.iptal; ozet.iptal = body.iptal.length; }
  store.guncelleme = body.guncelleme || new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  kaydet();
  return { tamam: true, ozet, bekleyen: bekleyen.length };
}

// Görev, işlediği sonuçları alıp tabloya yazar; alınanlar listeden düşer.
export function bekleyenleriAl() {
  const out = bekleyen;
  bekleyen = [];
  kaydet();
  return out;
}

const tr = (s) => String(s || '').toLocaleLowerCase('tr');
const canSeeAll = (u) => u.role === 'admin' || u.role === 'manager';
const tarihSuz = (rows, b, e) => rows.filter((r) => (!b || r.Tarih >= b) && (!e || r.Tarih <= e));

// --- Araçlar (Claude'un çağırabileceği fonksiyonlar) ---

// Tarih | Personel | Talep | Acilan | Acik | Iptal
export async function gunlukPerformans(user, { baslangic, bitis, personel }) {
  let rows = tarihSuz(store.gunluk, baslangic, bitis);
  if (!canSeeAll(user)) rows = rows.filter((r) => tr(r.Personel) === tr(user.name));
  else if (personel) rows = rows.filter((r) => tr(r.Personel) === tr(personel));
  return rows.length ? rows : { bilgi: 'Bu aralık için veri yok.', son_guncelleme: store.guncelleme };
}

// Tarih | Personel | Logon | Konusma | Bekleme | Mola | Cagri | OrtGorusme | Satis
export async function mantisRaporu(user, { baslangic, bitis, personel }) {
  let rows = tarihSuz(store.mantis, baslangic, bitis);
  if (!canSeeAll(user)) rows = rows.filter((r) => tr(r.Personel) === tr(user.name));
  else if (personel) rows = rows.filter((r) => tr(r.Personel) === tr(personel));
  return rows.length ? rows : { bilgi: 'Bu aralık için Mantis verisi yok.', son_guncelleme: store.guncelleme };
}

// Tarih | Personel | Aktif | TL  (sadece admin)
export async function hakedis(user, { baslangic, bitis, personel }) {
  if (user.role !== 'admin') return { hata: 'Hakediş bilgisini sadece Taha görebilir.' };
  let rows = tarihSuz(store.hakedis, baslangic, bitis);
  if (personel) rows = rows.filter((r) => tr(r.Personel) === tr(personel));
  return rows.length ? rows : { bilgi: 'Bu aralık için hakediş verisi yok.', son_guncelleme: store.guncelleme };
}

// İptal listesi. Personel yalnızca kendi listesini görür.
export async function iptalListesi(user, { personel, sadeceAranmamis }) {
  let kim;
  if (canSeeAll(user)) kim = personel;
  else if (user.role === 'backoffice') {
    if (!personel) return { hata: 'Hangi personelin listesini istediğini belirt (ör. "Damla\'nın aranmamış iptalleri").' };
    kim = personel;
  } else kim = user.name;
  let out = store.iptal;
  if (kim) out = out.filter((r) => tr(r.Personel) === tr(kim));
  if (sadeceAranmamis) out = out.filter((r) => !r['Arama tarihi']);
  return out.length ? out : { bilgi: 'Listede kayıt yok.', son_guncelleme: store.guncelleme };
}

// Sonuç bildirimi: hemen bellekteki listeye işlenir, görev bir sonraki çalışmada tabloya yazar.
export async function iptalSonucYaz(user, { talepId, sonuc, ulasildi, not }) {
  const izinli = ['Kurtarıldı', 'Tekrar aranacak', 'Kesin vazgeçti', 'Başka firmaya geçmiş', 'Ulaşılamadı'];
  if (!izinli.includes(sonuc)) return { hata: `Sonuç şunlardan biri olmalı: ${izinli.join(', ')}` };
  const row = store.iptal.find((r) => String(r['Talep ID']) === String(talepId));
  if (!row) return { hata: 'Bu talep ID iptal listesinde bulunamadı.' };
  if (!canSeeAll(user) && user.role !== 'backoffice' && tr(row.Personel) !== tr(user.name)) {
    return { hata: 'Bu müşteri senin listende değil.' };
  }
  const bugun = new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' });
  Object.assign(row, { 'Arama tarihi': bugun, 'Ulaşıldı mı?': ulasildi ? 'Evet' : 'Hayır', 'Sonuç': sonuc, 'Not': not || '' });
  bekleyen.push({ talepId: String(talepId), personel: row.Personel, tarih: bugun, ulasildi: ulasildi ? 'Evet' : 'Hayır', sonuc, not: not || '', bildiren: user.name });
  kaydet();
  return { tamam: true, not: 'Kaydedildi, tabloya bir sonraki güncellemede işlenecek.' };
}

export async function sonGuncelleme() {
  return { 'Son guncelleme': store.guncelleme };
}
