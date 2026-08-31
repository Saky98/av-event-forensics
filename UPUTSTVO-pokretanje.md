# 🚀 Kako pokrenuti projekat (na bilo kojoj mašini)

Najkraće uputstvo da projekat radi na tuđoj mašini — pull sa gita, instaliraj, pokreni.

---

## 0) Šta ti treba (dependencies)

Samo tri stvari koje su skoro svuda već instalirane:

| Potrebno | Verzija | Zašto |
|---|---|---|
| **Node.js** (sa `npm`) | 18+ (preporuka 20 / 22 LTS) | izvršava Vite i build |
| **Git** | bilo koja | povlačenje koda sa GitHub-a |
| **Browser** | Chrome / Edge / Firefox | otvaranje alata (localhost) |

> Vite 8 (ovde) traži **Node 18+**; najbezbednije je **Node 20 LTS ili noviji**.

---

## 1) Povuci projekat sa GitHub-a

Otvori terminal u folderu gde želiš projekat, pa:

```bash
git clone https://github.com/Saky98/av-event-forensics.git
cd av-event-forensics
```

> Ako nemaš Git, možeš i "Download ZIP" preko GitHub web-a, pa raspakuj.

---

## 2) Instaliraj dependencies (npm)

Iz korena projekta:

```bash
npm install
```

Ovo skida sve potrebne pakete navedene u `package.json`
(`@mcap/*`, `react`, `redux`, `three`, `uplot`, `vite` itd).

> Prvi put traje nekoliko desetina sekundi. Vidеš li poruke o zastarelim paketima — OK, nisu fatalne.

---

## 3) Pokreni dev server

```bash
npm run dev
```

Onda u browseru otvori adresu koju ispiše (obično):

```
http://localhost:5173/
```

Gotovo — alat se otvorio.

---

## 4) (Opciono) Ako nešto ne radi na tuđoj mašini

**Proveri Node verziju:**
```bash
node -v
```
=> mora biti **v18+** (najbezbednije v20/v22).

**Ako `npm install` padne** zbog mreže/verzije, probaj čistu instalaciju:
```bash
npm install --force
```

**Build (produkcija) — ako treba statički sajt:**
```bash
npm run build
npm run preview   # pregled build-a na localhost
```

---

## 5) Najvažniji fajlovi za demonstraciju

| Fajl | Šta je |
|---|---|
| `storage/Town02_truck_collision.mcap` | Demo snimak (72 MB) koji učitavaš u alat |
| `storage/compromised/Town02_truck_collision.mcap` | Kompromitovana kopija (~78 MB) za prikaz hash/chain |

> **Demo fajlovi su već u repou** (`storage/` je force-add-ovan), pa `git clone` ili ZIP automatski donosi i njih — za demonstraciju ti ne treba ništa dodatno.

---

## Brza provjera: da li je sve spremno

```bash
node -v      # 18+
npm -v
git --version
ls storage/Town02_truck_collision.mcap    # fajl mora postojati
```

Ako sve prođe → `npm install` → `npm run dev` → **http://localhost:5173/**
