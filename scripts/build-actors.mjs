/**
 * build-actors.mjs — génère src/data/actors.json pour « J'ai joué dans »
 *
 * Node 18+ requis (fetch natif).
 *   npm i dotenv
 *   npm run build:actors
 *
 * .env à la racine :
 *   TMDB_TOKEN=eyJhbGciOi...      <- jeton de lecture v4 (Bearer), pas la clé v3
 *
 * Pipeline :
 *   1. Corpus de films   — TMDB /discover, trié par nombre de votes, animation exclue
 *   2. Castings + sagas  — TMDB /movie/{id} avec append_to_response=credits
 *   3. Numéros d'épisode — TMDB /collection/{id}, ordonnés par date de sortie
 *   4. Nationalités      — Wikidata SPARQL via P4985 (identifiant TMDB personne)
 *   5. Seuils            — percentiles de notoriété calculés PAR catégorie
 *   6. Assemblage        — regroupement des sagas, niveau, export JSON
 *
 * Toutes les réponses HTTP sont mises en cache sur disque (scripts/.cache).
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import "dotenv/config";

/* =========================== RÉGLAGES =========================== */
const CONFIG = {
  pagesGlobal: 200,   // ~4000 films mondiaux les plus votés
  pagesFrance: 120,   // rattrape le déficit de votes du cinéma français
  pagesEurope: 100,

  minVotesFilm: 60,
  minYear: 1960,

  mainRoleMaxOrder: 2,   // « tête d'affiche »
  anyRoleMaxOrder: 9,    // second rôle inclus

  pctFameHigh: 0.75,  // facile / moyen
  pctFameLow: 0.50,   // difficile

  minFilmsPerActor: 5, // 3 affichés + 2 pour l'indice — après regroupement des sagas
  maxFilmsPerActor: 8,

  concurrency: 16,
  outFile: "../src/data/actors.json",
  cacheDir: ".cache",
};

const EU_COUNTRIES = [
  "GB", "IE", "DE", "AT", "CH", "IT", "ES", "PT", "BE", "NL", "LU",
  "DK", "SE", "NO", "FI", "IS", "PL", "CZ", "SK", "HU", "RO", "BG",
  "GR", "HR", "RS", "SI", "EE", "LV", "LT", "UA", "RU",
];

// 16 = animation, 99 = documentaire, 10770 = téléfilm
const EXCLUDED_GENRES = "16,99,10770";

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

  return cached(url.toString(), async () => {
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
      without_genres: EXCLUDED_GENRES,
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
    if ((m.genre_ids ?? []).includes(16)) continue; // filet de sécurité anti-animation
    const year = Number((m.release_date || "").slice(0, 4));
    if (!year || year < CONFIG.minYear) continue;
    const title = (m.title || m.original_title || "").trim();
    if (!title) continue;
    films.set(m.id, { id: m.id, t: title, y: year, votes: m.vote_count, col: null });
  }
  console.log(`\n${films.size} films retenus au total.`);
  return films;
}

/* ============ 2. CASTINGS ET APPARTENANCE AUX SAGAS ============ */
async function buildCredits(films) {
  console.log("\n> Castings et sagas");
  const ids = [...films.keys()];
  const actors = new Map();

  await pool(ids, async (filmId) => {
    let data;
    try {
      data = await tmdb(`/movie/${filmId}`, { append_to_response: "credits" });
    } catch {
      return;
    }
    if (data.belongs_to_collection) {
      films.get(filmId).col = {
        id: data.belongs_to_collection.id,
        name: data.belongs_to_collection.name,
      };
    }
    for (const c of data.credits?.cast ?? []) {
      if (c.order > CONFIG.anyRoleMaxOrder) continue;
      if (!c.name || !c.id) continue;
      let a = actors.get(c.id);
      if (!a) {
        a = { id: c.id, name: c.name.trim(), roles: [], photo: null };
        actors.set(c.id, a);
      }
      // Le portrait est déjà dans les crédits : aucun appel supplémentaire.
      // On garde celui du film le plus en vue, souvent le plus soigné.
      if (!a.photo && c.profile_path) a.photo = c.profile_path;
      a.roles.push({ filmId, order: c.order });
    }
  });

  for (const [id, a] of actors) {
    if (a.roles.length < CONFIG.minFilmsPerActor) actors.delete(id);
  }
  console.log(`${actors.size} acteurs candidats après élagage.`);
  return actors;
}

/* ================= 3. NUMÉROS D'ÉPISODE ================= */
async function buildEpisodeNumbers(films) {
  console.log("\n> Numérotation des sagas");
  const colIds = [...new Set([...films.values()].filter((f) => f.col).map((f) => f.col.id))];
  const order = new Map(); // filmId -> numéro dans la saga

  await pool(colIds, async (cid) => {
    let data;
    try {
      data = await tmdb(`/collection/${cid}`);
    } catch {
      return;
    }
    const parts = (data.parts ?? [])
      .filter((p) => p.release_date)
      .sort((a, b) => a.release_date.localeCompare(b.release_date));
    parts.forEach((p, i) => order.set(p.id, i + 1));
  });

  console.log(`${colIds.length} sagas identifiées.`);
  return order;
}

// « Harry Potter Collection », « Saga Harry Potter », « Harry Potter - Saga » -> « Harry Potter »
function cleanCollectionName(n) {
  return n
    .replace(/^(la\s+)?(saga|collection|s[ée]rie)\s+/i, "")
    .replace(/\s*[-–—:]?\s*(collection|saga|anthologie|trilogie|int[ée]grale)\s*$/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
}

/* ================= 4. NATIONALITÉS (WIKIDATA) ================= */
async function fetchNationalities(actors) {
  console.log("\n> Nationalités (Wikidata)");
  const ids = [...actors.keys()];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

  const map = new Map();
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
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        }
        throw new Error("Wikidata : trop de tentatives");
      });
    } catch {
      failed++;
      return;
    }

    const rank = (c) => (c === "FR" ? 3 : EU_COUNTRIES.includes(c) ? 2 : c === "US" ? 1 : 0);
    for (const b of json.results.bindings) {
      const tmdbId = Number(b.tmdb.value);
      const iso = b.iso.value;
      const prev = map.get(tmdbId);
      if (!prev || rank(iso) > rank(prev)) map.set(tmdbId, iso);
    }
    await new Promise((r) => setTimeout(r, 300));
  }, 2);

  if (failed) console.log(`\n   ${failed} lots en échec — relancez le script pour les rattraper.`);
  console.log(`${map.size} acteurs rattachés à un pays.`);
  return map;
}

function regionOf(iso) {
  if (iso === "FR") return "fr";
  if (EU_COUNTRIES.includes(iso)) return "eu";
  if (iso === "US") return "us";
  return "other";
}

/* ================= 5 & 6. SEUILS ET ASSEMBLAGE ================= */

/**
 * Regroupe les films d'une même saga en une seule entrée.
 * Deux films ou plus de la même collection -> « Harry Potter (2, 3, 4) ».
 * Un film isolé garde son titre propre.
 * La notoriété du groupe est celle de son épisode le plus vu.
 */
function groupSeries(filmList, epNumbers) {
  const groups = new Map();
  const ordered = [];

  for (const f of filmList) {
    if (!f.col) {
      ordered.push({ single: f });
      continue;
    }
    let g = groups.get(f.col.id);
    if (!g) {
      g = { name: f.col.name, items: [] };
      groups.set(f.col.id, g);
      ordered.push({ group: g });
    }
    g.items.push(f);
  }

  return ordered.map((e) => {
    if (e.single) {
      const f = e.single;
      return { t: f.t, y: f.y, votes: f.votes, order: f.order };
    }
    const items = e.group.items;
    if (items.length === 1) {
      const f = items[0];
      return { t: f.t, y: f.y, votes: f.votes, order: f.order };
    }
    const eps = items.map((f) => epNumbers.get(f.id)).filter(Boolean).sort((a, b) => a - b);
    const years = items.map((f) => f.y).sort((a, b) => a - b);
    return {
      t: cleanCollectionName(e.group.name),
      eps,
      y: years[0],
      y2: years[years.length - 1],
      votes: Math.max(...items.map((f) => f.votes)),
      order: Math.min(...items.map((f) => f.order)),
    };
  });
}

function assemble(actors, films, natMap, epNumbers) {
  console.log("\n> Seuils et assemblage");

  const enriched = [];
  for (const a of actors.values()) {
    const iso = natMap.get(a.id);
    if (!iso) continue;

    const seen = new Set();
    const filmo = a.roles
      .map((r) => {
        const f = films.get(r.filmId);
        return f ? { ...f, order: r.order } : null;
      })
      .filter((f) => f && f.t && !seen.has(f.id) && seen.add(f.id));

    const grouped = groupSeries(filmo, epNumbers).sort((x, y) => y.votes - x.votes);
    enriched.push({ ...a, region: regionOf(iso), films: grouped });
  }

  // Seuils par catégorie, calculés sur les entrées regroupées
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
      photo: a.photo || null,
      films: selection.slice(0, CONFIG.maxFilmsPerActor).map((f) => {
        const e = { t: f.t, y: f.y };
        if (f.eps && f.eps.length) e.eps = f.eps;
        if (f.y2 && f.y2 !== f.y) e.y2 = f.y2;
        return e;
      }),
    });
  }

  out.sort((x, y) => x.name.localeCompare(y.name, "fr"));
  return out;
}

/* ============================ MAIN ============================ */
const films = await buildFilmCorpus();
const actors = await buildCredits(films);
const epNumbers = await buildEpisodeNumbers(films);
const natMap = await fetchNationalities(actors);
const finalPool = assemble(actors, films, natMap, epNumbers);

const counts = {};
for (const a of finalPool) {
  const k = `${a.region}/${a.level}`;
  counts[k] = (counts[k] || 0) + 1;
}
console.log("\n=== Pool final ===");
console.log(`${finalPool.length} acteurs`);
console.table(counts);

const grouped = finalPool.reduce(
  (n, a) => n + a.films.filter((f) => f.eps).length, 0);
console.log(`${grouped} entrées de saga regroupées.`);

const noPhoto = finalPool.filter((a) => !a.photo).length;
console.log(`${finalPool.length - noPhoto} portraits disponibles (${noPhoto} sans photo).`);

const byLast = new Map();
for (const a of finalPool) {
  const last = a.name.trim().split(/\s+/).pop().toLowerCase();
  byLast.set(last, (byLast.get(last) || 0) + 1);
}
console.log(`${[...byLast].filter(([, n]) => n > 1).length} patronymes partagés.`);

const outPath = path.resolve(here, CONFIG.outFile);
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(finalPool, null, 0));
console.log(`\nÉcrit : ${outPath}`);
