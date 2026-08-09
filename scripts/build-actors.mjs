/**
 * build-actors.mjs — génère src/data/actors.json pour « J'ai joué dans »
 *
 * Node 18+ requis (fetch natif).
 *   npm i dotenv
 *   node scripts/build-actors.mjs
 *
 * Variables d'environnement (.env à la racine) :
 *   TMDB_TOKEN=eyJhbGciOi...      <- jeton de lecture v4 (Bearer), pas la clé v3
 *
 * Pipeline :
 *   1. Corpus de films   — TMDB /discover, trié par nombre de votes
 *   2. Castings          — TMDB /movie/{id}/credits, on garde l'ordre au générique
 *   3. Nationalités      — Wikidata SPARQL via P4985 (identifiant TMDB personne)
 *   4. Seuils            — percentiles de notoriété calculés PAR catégorie
 *   5. Assemblage        — attribution d'un niveau et export JSON
 *
 * Toutes les réponses HTTP sont mises en cache sur disque (scripts/.cache).
 * Une réexécution ne recoûte donc presque rien.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import "dotenv/config";
import { fileURLToPath } from "node:url";

/* =========================== RÉGLAGES =========================== */
const CONFIG = {
  // Taille du corpus. 1 page = 20 films.
  pagesGlobal: 200,   // ~4000 films mondiaux les plus votés
  pagesFrance: 120,   // ~2400 films d'origine française (rattrape le déficit de votes)
  pagesEurope: 100,   // ~2000 films d'autres pays européens

  minVotesFilm: 60,   // plancher absolu, écarte le bruit
  minYear: 1960,

  mainRoleMaxOrder: 2,   // « tête d'affiche »
  anyRoleMaxOrder: 9,    // « second rôle » inclus

  // Percentiles de notoriété, calculés à l'intérieur de chaque catégorie
  pctFameHigh: 0.75,  // facile / moyen : top 15 %
  pctFameLow: 0.50,   // difficile      : top 50 %

  minFilmsPerActor: 5, // 3 affichés + 2 pour l'indice
  maxFilmsPerActor: 8, // ce qu'on stocke dans le JSON

  concurrency: 16,
  outFile: "../src/data/actors.json",
  cacheDir: ".cache",
};

// Pays européens hors France retenus pour le corpus et la catégorisation
const EU_COUNTRIES = [
  "GB", "IE", "DE", "AT", "CH", "IT", "ES", "PT", "BE", "NL", "LU",
  "DK", "SE", "NO", "FI", "IS", "PL", "CZ", "SK", "HU", "RO", "BG",
  "GR", "HR", "RS", "SI", "EE", "LV", "LT", "UA", "RU",
];

/* ========================== UTILITAIRES ========================== */
const TOKEN = process.env.TMDB_TOKEN;
if (!TOKEN) {
  console.error("TMDB_TOKEN manquant. Ajoutez-le dans .env (jeton de lecture v4).");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, CONFIG.cacheDir);

async function cached(key, fn) {
  const file = path.join(cacheDir, crypto.createHash("md5").update(key).digest("hex") + ".json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    const data = await fn();
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(data));
    return data;
  }
}

async function tmdb(endpoint, params = {}) {
  const url = new URL("https://api.themoviedb.org/3" + endpoint);
  url.searchParams.set("language", "fr-FR");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const key = url.toString();

  return cached(key, async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
      });
      if (res.status === 429) {
        const wait = Number(res.headers.get("retry-after") || 1) * 1000 + 250;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`TMDB ${res.status} sur ${endpoint}`);
      return res.json();
    }
    throw new Error(`TMDB : trop de tentatives sur ${endpoint}`);
  });
}

// Exécute les tâches par lots, sans dépendance externe
async function pool(items, worker, size = CONFIG.concurrency) {
  const out = [];
  let cursor = 0;
  let done = 0;
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
      if (++done % 200 === 0) process.stdout.write(`\r   ${done}/${items.length}`);
    }
  });
  await Promise.all(runners);
  process.stdout.write(`\r   ${items.length}/${items.length}\n`);
  return out;
}

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length));
  return sortedAsc[i];
}

/* ================= 1. CORPUS DE FILMS ================= */
async function discover(pages, extra, label) {
  console.log(`\n> Films — ${label}`);
  const pageList = Array.from({ length: pages }, (_, i) => i + 1);
  const results = await pool(pageList, (page) =>
    tmdb("/discover/movie", {
      page,
      sort_by: "vote_count.desc",
      include_adult: "false",
      "vote_count.gte": CONFIG.minVotesFilm,
      "primary_release_date.gte": `${CONFIG.minYear}-01-01`,
      with_runtime_gte: 60,
      without_genres: "99,10770", // documentaire, téléfilm
      ...extra,
    })
  );
  return results.flatMap((r) => r?.results ?? []);
}

async function buildFilmCorpus() {
  const batches = await Promise.all([
    discover(CONFIG.pagesGlobal, {}, "mondial"),
    discover(CONFIG.pagesFrance, { with_origin_country: "FR" }, "France"),
    discover(CONFIG.pagesEurope, { with_origin_country: EU_COUNTRIES.join("|") }, "Europe"),
  ]);

  const films = new Map();
  for (const m of batches.flat()) {
    if (!m?.id || films.has(m.id)) continue;
    const year = Number((m.release_date || "").slice(0, 4));
    if (!year || year < CONFIG.minYear) continue;
    const title = (m.title || m.original_title || "").trim();
    if (!title) continue;
    films.set(m.id, { id: m.id, t: title, y: year, votes: m.vote_count });
  }
  console.log(`\n${films.size} films retenus au total.`);
  return films;
}

/* ================= 2. CASTINGS ================= */
async function buildCredits(films) {
  console.log("\n> Castings");
  const ids = [...films.keys()];
  const actors = new Map(); // tmdbId -> { id, name, roles: [{filmId, order}] }

  await pool(ids, async (filmId) => {
    let data;
    try {
      data = await tmdb(`/movie/${filmId}/credits`);
    } catch {
      return;
    }
    for (const c of data.cast ?? []) {
      if (c.order > CONFIG.anyRoleMaxOrder) continue;
      if (!c.name || !c.id) continue;
      let a = actors.get(c.id);
      if (!a) {
        a = { id: c.id, name: c.name.trim(), roles: [] };
        actors.set(c.id, a);
      }
      a.roles.push({ filmId, order: c.order });
    }
  });

  // On élague tout de suite : inutile d'interroger Wikidata pour 200 000 figurants
  for (const [id, a] of actors) {
    if (a.roles.length < CONFIG.minFilmsPerActor) actors.delete(id);
  }
  console.log(`${actors.size} acteurs candidats après élagage.`);
  return actors;
}

/* ================= 3. NATIONALITÉS (WIKIDATA) ================= */
async function fetchNationalities(actors) {
  console.log("\n> Nationalités (Wikidata)");
  const ids = [...actors.keys()];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));	

  const map = new Map(); // tmdbId -> code ISO pays

let failed = 0;

  await pool(chunks, async (chunk) => {
    const values = chunk.map((id) => `"${id}"`).join(" ");
    const sparql = `
      SELECT ?tmdb ?iso WHERE {
        VALUES ?tmdb { ${values} }
        ?person wdt:P4985 ?tmdb ;
                wdt:P27 ?country .
        ?country wdt:P297 ?iso .
      }`;
    const key = "wd:" + crypto.createHash("md5").update(sparql).digest("hex");

    let json;
    try {
      json = await cached(key, async () => {
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            const res = await fetch("https://query.wikidata.org/sparql", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/sparql-results+json",
                "User-Agent": "JaiJoueDans/1.0 (jeu de quiz cinema)",
              },
              body: new URLSearchParams({ query: sparql }),
            });
            if (res.ok) return res.json();
            if (![429, 500, 502, 503, 504].includes(res.status)) {
              throw new Error(`Wikidata ${res.status}`);
            }
          } catch (e) {
            if (attempt === 5) throw e;
          }
          // Attente croissante : 2s, 4s, 8s, 16s, 32s
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        }
        throw new Error("Wikidata : trop de tentatives");
      });
    } catch {
      failed++;
      return; // le lot n'est pas mis en cache, il sera retenté au prochain lancement
    }

    for (const b of json.results.bindings) {
      const tmdbId = Number(b.tmdb.value);
      const iso = b.iso.value;
	  const rank = (c) => (c === "FR" ? 3 : EU_COUNTRIES.includes(c) ? 2 : c === "US" ? 1 : 0);
      const prev = map.get(tmdbId);
      if (!prev || rank(iso) > rank(prev)) map.set(tmdbId, iso);
    }
    await new Promise((r) => setTimeout(r, 300)); // on ménage l'endpoint public
  }, 2);

  if (failed) console.log(`\n   ${failed} lots en échec — relancez le script pour les rattraper.`); // Wikidata n'aime pas la concurrence, on reste doux

  console.log(`${map.size} acteurs rattachés à un pays.`);
  return map;
}

function regionOf(iso) {
  if (iso === "FR") return "fr";
  if (EU_COUNTRIES.includes(iso)) return "eu";
  if (iso === "US") return "us";
  return "other";
}

/* ================= 4 & 5. SEUILS ET ASSEMBLAGE ================= */
function assemble(actors, films, natMap) {
  console.log("\n> Seuils et assemblage");

  // Rattachement région + filmographie enrichie
  const enriched = [];
  for (const a of actors.values()) {
    const iso = natMap.get(a.id);
    if (!iso) continue;
    const region = regionOf(iso);
    const filmo = a.roles
      .map((r) => ({ ...films.get(r.filmId), order: r.order }))
      .filter((f) => f && f.t);
    // Un même film peut remonter deux fois (doublons de casting)
    const seen = new Set();
    const uniq = filmo.filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));
    uniq.sort((x, y) => y.votes - x.votes);
    enriched.push({ ...a, region, films: uniq });
  }

  // Seuils par catégorie : distribution des votes sur les films joués par cette catégorie
  const thresholds = {};
  for (const region of ["fr", "eu", "us", "other"]) {
    const votes = [];
    for (const a of enriched) {
      if (a.region !== region) continue;
      for (const f of a.films) votes.push(f.votes);
    }
    votes.sort((x, y) => x - y);
    thresholds[region] = {
      high: quantile(votes, CONFIG.pctFameHigh),
      low: quantile(votes, CONFIG.pctFameLow),
    };
    console.log(
      `   ${region} : seuil haut ${thresholds[region].high} votes, seuil bas ${thresholds[region].low}`
    );
  }

  const out = [];
  for (const a of enriched) {
    const th = thresholds[a.region];
    const main = a.films.filter((f) => f.order <= CONFIG.mainRoleMaxOrder && f.votes >= th.high);
    const any = a.films.filter((f) => f.votes >= th.high);
    const wide = a.films.filter((f) => f.votes >= th.low);

    let level = null;
    let selection = null;
    if (main.length >= CONFIG.minFilmsPerActor) { level = "facile"; selection = any; }
    else if (any.length >= CONFIG.minFilmsPerActor) { level = "moyen"; selection = any; }
    else if (wide.length >= CONFIG.minFilmsPerActor) { level = "difficile"; selection = wide; }
    if (!level) continue;

    out.push({
      id: `tmdb:${a.id}`,
      name: a.name,
      aka: [],
      region: a.region,
      level,
      films: selection
        .slice(0, CONFIG.maxFilmsPerActor)
        .map((f) => ({ t: f.t, y: f.y })),
    });
  }

  out.sort((x, y) => x.name.localeCompare(y.name, "fr"));
  return out;
}

/* ============================ MAIN ============================ */
const films = await buildFilmCorpus();
const actors = await buildCredits(films);
const natMap = await fetchNationalities(actors);
const pool_ = assemble(actors, films, natMap);

// Rapport
const counts = {};
for (const a of pool_) {
  const k = `${a.region}/${a.level}`;
  counts[k] = (counts[k] || 0) + 1;
}
console.log("\n=== Pool final ===");
console.log(`${pool_.length} acteurs`);
console.table(counts);

// Homonymes de patronyme : le jeu exigera le nom complet pour ceux-là
const byLast = new Map();
for (const a of pool_) {
  const last = a.name.trim().split(/\s+/).pop().toLowerCase();
  byLast.set(last, (byLast.get(last) || 0) + 1);
}
const collisions = [...byLast].filter(([, n]) => n > 1);
console.log(`${collisions.length} patronymes partagés (nom complet requis en jeu).`);

const outPath = path.resolve(here, CONFIG.outFile);
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(pool_, null, 0));
console.log(`\nÉcrit : ${outPath}`);
