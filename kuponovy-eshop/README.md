# Kupónový e-shop

Jednoduchý, ale kompletní e-shop na prodej **digitálních kódů / kupónů**, které zákazníkovi dorazí **na e-mail hned po zaplacení**. Postavené na Node.js + SQLite (jeden soubor, žádný extra databázový server).

> ⚠️ **Důležité:** Prodávej jen kódy, které máš právo prodávat — vlastní produkt nebo oficiální reseller licence od poskytovatele služby. Přeprodej cizích účtů nebo neautorizovaných kódů porušuje podmínky služeb a bývá nelegální. Tenhle software je neutrální nástroj; za legálnost sortimentu zodpovídáš ty.

## Co umí

- **Katalog produktů** + sklad kódů (každý produkt má vlastní zásobu kódů).
- **CMS / admin panel** (`/admin`): přidávání a editace produktů, hromadné vkládání kódů (jeden na řádek), správa objednávek, nastavení obchodu.
- **Platby:**
  - **Stripe** (karta) — plně automaticky: po zaplacení se kód ihned odešle.
  - **Krypto** (např. BTC) — zobrazí adresu, platbu **potvrzuješ ručně** v adminu.
  - **Bankovní převod / IBAN** — zobrazí IBAN + číslo objednávky jako referenci, platbu **potvrzuješ ručně**.
- **Rezervace kódů** — při objednávce se kód zarezervuje, takže se neprodá dvakrát. Nezaplacené rezervace se po 7 dnech automaticky uvolní.
- **Účty zákazníků** (registrace/login) + přehled jejich objednávek. Nákup jde i bez registrace (stačí e-mail).
- **Odeslání kódů e-mailem** přes libovolné SMTP (Seznam, Gmail, Brevo, Mailgun…).

## Rychlý start (lokálně)

Potřebuješ **Node.js 18+**.

```bash
npm install
cp .env.example .env
# otevři .env a nastav aspoň SESSION_SECRET, ADMIN_EMAIL a ADMIN_PASSWORD
npm start
```

Obchod běží na `http://localhost:3000`, admin na `http://localhost:3000/admin` (přihlas se údaji z `.env`).

Tajný klíč pro session vygeneruješ třeba takhle:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### První kroky v adminu
1. Přihlas se na `/admin`.
2. **Nastavení** → název obchodu, měna, krypto adresa, IBAN.
3. **Produkty → + Nový produkt** → vyplň název a cenu.
4. Na stránce produktu dole **vlož kódy** (jeden na řádek) — to je tvůj sklad.
5. Hotovo, produkt se objeví na hlavní stránce.

## Platby – nastavení

### Stripe (karta, automatické)
1. Účet na <https://dashboard.stripe.com>, zkopíruj **Secret key** do `.env` → `STRIPE_SECRET_KEY`.
2. Vytvoř webhook: Dashboard → Developers → **Webhooks** → Add endpoint:
   - URL: `https://tvojedomena.cz/webhook/stripe`
   - Událost: `checkout.session.completed`
3. Zkopíruj **Signing secret** webhooku do `.env` → `STRIPE_WEBHOOK_SECRET`.
4. Restartuj aplikaci. Platba kartou se teď nabídne a kódy se odešlou samy.

> Lokální test webhooku: `stripe listen --forward-to localhost:3000/webhook/stripe` (Stripe CLI).

### Krypto a IBAN (ruční potvrzení)
Zapni je a vyplň údaje v **Admin → Nastavení**. Zákazník po zaplacení uvidí instrukce a nahlásí referenci; ty v **Admin → Objednávky** otevřeš objednávku a klikneš **Potvrdit platbu a doručit kódy**. Kódy se tím odešlou e-mailem.

### E-mail (SMTP)
Vyplň `SMTP_*` v `.env`. Příklady:
- **Seznam.cz:** host `smtp.seznam.cz`, port `465`, `SMTP_SECURE=true`.
- **Gmail:** host `smtp.gmail.com`, port `587`, heslo = *App password* (ne běžné heslo).

Když SMTP nevyplníš, obchod funguje dál — kódy jen neodejdou mailem, ale uvidíš je v adminu a zákazník na stránce objednávky.

## Kde to hostovat

SQLite = jeden soubor (`data/shop.sqlite`), takže potřebuješ hosting s **trvalým diskem**. Doporučení od nejlevnějšího:

### 1) Malý VPS (nejlevnější a nejspolehlivější) — např. Hetzner CX22 (~5 €/měs)
```bash
# na serveru (Ubuntu):
sudo apt update && sudo apt install -y nodejs npm
git clone <tvoje repo> /opt/shop && cd /opt/shop
npm install --omit=dev
cp .env.example .env && nano .env   # vyplň BASE_URL=https://tvojedomena.cz, SECURE_COOKIES=true, klíče...
```
Spusť jako službu (systemd) – vytvoř `/etc/systemd/system/shop.service`:
```ini
[Unit]
Description=Coupon shop
After=network.target
[Service]
WorkingDirectory=/opt/shop
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now shop
```
Před aplikaci dej **HTTPS reverzní proxy** — nejjednodušší je **Caddy** (řeší certifikát automaticky):
```
tvojedomena.cz {
    reverse_proxy localhost:3000
}
```

### 2) Render.com / Railway.app (bez správy serveru)
- Vytvoř Web Service z repa, build `npm install`, start `npm start`.
- Přidej **Persistent Disk / Volume** a připoj ho např. na `/data`.
- Nastav proměnnou `DATA_DIR=/data` (aby tam šla databáze) + ostatní z `.env`.
- `SECURE_COOKIES=true`, `BASE_URL=https://...` (veřejná adresa služby).

### 3) Fly.io
Funguje stejně — vytvoř **volume** a nastav `DATA_DIR` na mount point.

> ❌ **Nehostuj na Vercelu/Netlify.** Jsou „serverless" — nemají trvalý disk pro SQLite ani stálý proces pro session a webhooky. Pro tenhle projekt se nehodí.

## Bezpečnost / provoz – checklist
- [ ] Změň `ADMIN_PASSWORD` a nastav dlouhý náhodný `SESSION_SECRET`.
- [ ] V produkci `SECURE_COOKIES=true` a běž **pod HTTPS**.
- [ ] Správně nastav `BASE_URL` (kvůli Stripe návratům a odkazům v e-mailu).
- [ ] **Zálohuj** soubor `data/shop.sqlite` (jsou v něm produkty, kódy i objednávky).
- [ ] Admin účet se vytvoří z `.env` při prvním startu; pak si klidně `ADMIN_PASSWORD` z `.env` změň.

## Struktura projektu
```
server.js            vstupní bod (Express, session, Stripe webhook)
src/db.js            SQLite schéma, nastavení, seed admina
src/service.js       objednávky, rezervace a doručení kódů
src/mailer.js        odesílání e-mailů (nodemailer)
src/middleware.js    přihlášení, admin, CSRF, flash zprávy
routes/shop.js       obchod + checkout + stav objednávky
routes/auth.js       registrace / login / účet
routes/admin.js      admin panel (produkty, kódy, objednávky, nastavení)
views/               EJS šablony
public/style.css     vzhled
data/                databáze (vytvoří se automaticky; zálohuj!)
```
