import React, { useState, useEffect, useRef, useMemo } from "react";
import POOL from "./data/actors.json";
import oscarImg from "./assets/oscar.png";

/* ============================================================
   J'AI JOUÉ DANS — devine l'acteur à partir de sa filmographie
   ------------------------------------------------------------
   actors.json est généré par scripts/build-actors.mjs (TMDB + Wikidata).
   Chaque entrée :

   {
     id: string,            // "tmdb:1234"
     name: string,
     aka: string[],         // graphies alternatives acceptées
     region: "fr"|"eu"|"us"|"other",        // région principale (pays de naissance)
     regions: (...)[],                      // toutes ses nationalités -> badge
     level: "facile"|"moyen"|"difficile",
     photo: string | null,                  // chemin TMDB, ex. "/abc.jpg"
     films: [{ t, y, eps?, y2? }]   // triés par notoriété décroissante
   }

   eps / y2 ne sont présents que sur les sagas regroupées :
   { t: "Harry Potter", eps: [2,3,4], y: 2002, y2: 2005 }
   ============================================================ */


/* ---------- Réglages de jeu ---------- */
const CATEGORIES = [
  { id: "fr", label: "Acteurs français", regions: ["fr"] },
  { id: "eu", label: "Acteurs européens", regions: ["fr", "eu"] },
  { id: "us", label: "Acteurs américains", regions: ["us"] },
  { id: "world", label: "Reste du monde", regions: ["other"], noDiff: true },
  { id: "global", label: "Global", regions: ["fr", "eu", "us", "other"] },
];
const DIFFICULTIES = [
  { id: "facile", label: "Facile", levels: ["facile"], note: "Têtes d'affiche des grands films" },
  { id: "moyen", label: "Moyen", levels: ["facile", "moyen"], note: "+ seconds rôles" },
  { id: "difficile", label: "Difficile", levels: ["facile", "moyen", "difficile"], note: "+ films plus confidentiels" },
];
const LIVES_START = 3;
const STREAK_STEP = 5;
const STREAK_BONUS = 3;

/* ---------- Palette ---------- */
const C = {
  deep: "#3D0A12",
  curtain: "#7B1122",
  velvet: "#9E2233",
  gold: "#C9A227",
  goldLight: "#F0D77B",
  cream: "#F6EEE3",
};

/* ---------- Correspondance tolérante ---------- */
function normalize(s) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}
function tolerance(len) {
  if (len <= 6) return 1;
  if (len <= 12) return 2;
  return 3;
}
function isMatch(guess, actor, pool) {
  const g = normalize(guess);
  if (!g) return false;
  const candidates = [actor.name, ...actor.aka];
  for (const c of candidates) {
    const full = normalize(c);
    if (levenshtein(g, full) <= tolerance(full.length)) return true;
  }
  // Nom de famille seul, uniquement s'il est sans ambiguïté dans le pool
  const parts = actor.name.trim().split(/\s+/);
  const last = normalize(parts[parts.length - 1]);
  const collisions = pool.filter((p) => {
    const q = p.name.trim().split(/\s+/);
    return normalize(q[q.length - 1]) === last;
  }).length;
  if (collisions === 1 && last.length >= 4) {
    return levenshtein(g, last) <= tolerance(last.length);
  }
  return false;
}
/* Une saga s'affiche « Harry Potter (2, 3, 4) » avec la plage d'années */
const filmTitle = (f) => (f.eps && f.eps.length ? `${f.t} (${f.eps.join(", ")})` : f.t);
const filmYear = (f) => (f.y2 && f.y2 !== f.y ? `${f.y}–${f.y2}` : String(f.y));

/* Portrait TMDB, avec repli sur la statuette si absent ou en échec */
function Portrait({ actor }) {
  const [failed, setFailed] = useState(false);
  const src = actor.photo && !failed
    ? `https://image.tmdb.org/t/p/w185${actor.photo}`
    : null;

  const frame = {
    width: 116, height: 116, borderRadius: "50%", overflow: "hidden",
    border: `2px solid ${C.gold}`, boxShadow: `0 0 22px ${C.gold}55`,
    background: C.curtain, display: "flex", alignItems: "center",
    justifyContent: "center", flexShrink: 0,
  };

  return (
    <div style={frame}>
      {src ? (
        <img
          src={src} alt="" loading="lazy" onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover",
                   objectPosition: "center 22%" }} />
      ) : (
        <span style={{ opacity: .45, lineHeight: 0 }}><Oscar size={30} /></span>
      )}
    </div>
  );
}

/* « Jean Dujardin » -> « J _ _ _   D _ _ _ _ _ _ _ » */
function maskedName(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const letters = [...w];
      return letters[0].toUpperCase() + " " + letters.slice(1).map(() => "_").join(" ");
    })
    .join("\u2003");
}

/* ---------- Logo ---------- */
/* Statuette : image dans src/assets/oscar.png (ratio 256x576 ≈ 4:9).
   size = largeur en px ; la hauteur suit le ratio. */
const OSCAR_RATIO = 576 / 256;

function Oscar({ size = 40, glow = false }) {
  return (
    <img
      src={oscarImg} alt="" aria-hidden="true" draggable="false"
      width={size} height={Math.round(size * OSCAR_RATIO)}
      style={{
        display: "block",
        width: size, height: Math.round(size * OSCAR_RATIO),
        objectFit: "contain",
        filter: glow ? `drop-shadow(0 0 10px ${C.gold}88)` : "none",
        userSelect: "none",
      }} />
  );
}

const styleSheet = `
@import url('https://fonts.googleapis.com/css2?family=Bodoni+Moda:opsz,wght@6..96,400;6..96,700&family=Barlow+Condensed:wght@400;500;600&display=swap');
html, body, #root { margin: 0; background: #260609; }
.jjd * { box-sizing: border-box; }
.jjd { font-family: 'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif; }
.jjd h1, .jjd h2, .jjd .display { font-family: 'Bodoni Moda', Didot, Georgia, serif; }
.jjd button { font-family: inherit; cursor: pointer; border: none; }
.jjd button:focus-visible, .jjd input:focus-visible {
  outline: 2px solid ${C.goldLight}; outline-offset: 2px;
}
.jjd-btn { transition: transform .12s ease, box-shadow .12s ease, background .12s ease; }
.jjd-btn:hover:not(:disabled) { transform: translateY(-1px); }
.jjd-btn:disabled { opacity: .4; cursor: not-allowed; }
.jjd-ticket::before, .jjd-ticket::after {
  content: ''; position: absolute; top: 0; bottom: 0; width: 14px;
  background-image: radial-gradient(circle at center, ${C.deep} 3.5px, transparent 4px);
  background-size: 14px 22px; background-position: center;
}
.jjd-ticket::before { left: 0; }
.jjd-ticket::after { right: 0; }
@keyframes jjdIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.jjd-in { animation: jjdIn .35s ease both; }
@keyframes jjdShake { 10%,90%{transform:translateX(-2px)} 30%,70%{transform:translateX(4px)} 50%{transform:translateX(-4px)} }
.jjd-shake { animation: jjdShake .4s ease; }
@media (prefers-reduced-motion: reduce) {
  .jjd-in, .jjd-shake { animation: none; }
  .jjd-btn:hover { transform: none; }
}
`;

/* ---------- Petits composants ---------- */
function Lives({ n }) {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}
         aria-label={`${n} vie${n > 1 ? "s" : ""} restante${n > 1 ? "s" : ""}`}>
      {Array.from({ length: LIVES_START }).map((_, i) => (
        <span key={i} style={{ opacity: i < n ? 1 : 0.18, lineHeight: 0 }}>
          <Oscar size={10} />
        </span>
      ))}
    </div>
  );
}

function Pill({ children, active, onClick, sub }) {
  return (
    <button className="jjd-btn" onClick={onClick} aria-pressed={active}
      style={{
        background: active ? C.gold : "transparent",
        color: active ? C.deep : C.cream,
        border: `1px solid ${active ? C.gold : "#ffffff33"}`,
        borderRadius: 3, padding: "10px 14px", textAlign: "left",
        fontSize: 15, letterSpacing: ".06em", textTransform: "uppercase",
        fontWeight: 600, width: "100%",
      }}>
      {children}
      {sub && (
        <span style={{ display: "block", fontSize: 12, opacity: .7, textTransform: "none",
                       letterSpacing: 0, fontWeight: 400, marginTop: 2 }}>{sub}</span>
      )}
    </button>
  );
}

/* ============================================================ */
export default function App() {
  const [screen, setScreen] = useState("home");
  const [category, setCategory] = useState("fr");
  const [difficulty, setDifficulty] = useState("facile");

  const [queue, setQueue] = useState([]);
  const [current, setCurrent] = useState(null);
  const [hints, setHints] = useState(0);
  const [guess, setGuess] = useState("");
  const [wrong, setWrong] = useState(false);
  const [lives, setLives] = useState(LIVES_START);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [best, setBest] = useState(0);
  const [found, setFound] = useState(0);
  const [reveal, setReveal] = useState(null);
  const [board, setBoard] = useState([]);
  const [pseudo, setPseudo] = useState("");
  const inputRef = useRef(null);

  const activePool = useMemo(() => {
    const cat = CATEGORIES.find((c) => c.id === category);
    const dif = DIFFICULTIES.find((d) => d.id === difficulty);
    // Le classement se fait sur la région principale ; `regions` ne sert qu'au badge.
    return POOL.filter(
      (a) => cat.regions.includes(a.region) && (cat.noDiff || dif.levels.includes(a.level))
    );
  }, [category, difficulty]);

  useEffect(() => {
    if (screen === "play" && inputRef.current) inputRef.current.focus();
  }, [screen, current]);

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function start() {
    const q = shuffle(activePool);
    setQueue(q.slice(1));
    setCurrent(q[0]);
    setHints(0); setGuess(""); setWrong(false);
    setLives(LIVES_START); setScore(0); setStreak(0); setBest(0); setFound(0);
    setScreen("play");
  }

  function next() {
    if (!queue.length) { setScreen("over"); return; }
    setCurrent(queue[0]);
    setQueue(queue.slice(1));
    setHints(0); setGuess(""); setWrong(false);
    setScreen("play");
  }

  function submit() {
    if (!guess.trim() || !current) return;
    if (isMatch(guess, current, POOL)) {
      const pts = 3 - hints;
      const ns = streak + 1;
      const bonus = ns % STREAK_STEP === 0 ? STREAK_BONUS : 0;
      setScore((s) => s + pts + bonus);
      setStreak(ns);
      setBest((b) => Math.max(b, ns));
      setFound((f) => f + 1);
      setReveal({ actor: current, outcome: "trouve", points: pts, bonus, shown: hints >= 1 ? 5 : 3 });
      setScreen("reveal");
    } else {
      const l = lives - 1;
      setLives(l);
      setStreak(0);
      setWrong(true);
      setGuess("");
      setTimeout(() => setWrong(false), 450);
      if (l <= 0) {
        setReveal({ actor: current, outcome: "rate", points: 0, bonus: 0, shown: hints >= 1 ? 5 : 3 });
        setScreen("reveal");
      }
    }
  }

  function skip() {
    setLives((l) => l - 1);
    setStreak(0);
    setReveal({ actor: current, outcome: "passe", points: 0, bonus: 0, shown: hints >= 1 ? 5 : 3 });
    setScreen("reveal");
  }

  function afterReveal() {
    if (lives <= 0) setScreen("over");
    else next();
  }

  function saveScore() {
    // TODO : remplacer par addDoc(collection(db, "scores"), entry)
    const entry = {
      pseudo: pseudo.trim() || "Anonyme",
      score, categorie: category,
      difficulte: CATEGORIES.find((c) => c.id === category).noDiff ? "tous" : difficulty,
      streak: best, createdAt: Date.now(),
    };
    setBoard((b) => [...b, entry].sort((x, y) => y.score - x.score).slice(0, 10));
    setPseudo("");
    setScreen("board");
  }

  const shownFilms = current ? current.films.slice(0, hints >= 1 ? 5 : 3) : [];
  const activeCat = CATEGORIES.find((c) => c.id === category);
  const catLabel = activeCat.label;
  const difLabel = activeCat.noDiff
    ? "Tous niveaux"
    : DIFFICULTIES.find((d) => d.id === difficulty).label;

  const shell = {
    minHeight: "100vh", width: "100%", color: C.cream,
    background: `radial-gradient(120% 80% at 50% -10%, ${C.curtain} 0%, ${C.deep} 55%, #260609 100%)`,
    display: "flex", justifyContent: "center", padding: "24px 22px 48px",
  };
  const panel = { width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", gap: 20 };
  const goldBtn = {
    background: `linear-gradient(180deg, ${C.goldLight}, ${C.gold})`,
    color: C.deep, borderRadius: 3, padding: "14px 20px", fontSize: 17,
    fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", width: "100%",
    boxShadow: "0 6px 18px #0006",
  };
  const ghostBtn = {
    background: "transparent", color: C.cream, border: "1px solid #ffffff33",
    borderRadius: 3, padding: "11px 16px", fontSize: 14,
    letterSpacing: ".08em", textTransform: "uppercase",
  };

  return (
    <div className="jjd" style={shell}>
      <style>{styleSheet}</style>
      <div style={panel}>

        <header style={{ display: "flex", alignItems: "center", gap: 14, justifyContent: "center" }}>
          <Oscar size={22} glow />
          <div style={{ textAlign: "center" }}>
            <h1 className="display" style={{
              margin: 0, fontSize: 30, letterSpacing: ".02em", lineHeight: 1,
              color: C.cream, fontWeight: 400 }}>
              J'ai joué <em style={{ color: C.goldLight }}>dans</em>
            </h1>
            <div style={{ fontSize: 11, letterSpacing: ".34em", textTransform: "uppercase",
                          opacity: .6, marginTop: 6 }}>
              Devinez l'acteur
            </div>
          </div>
          <Oscar size={22} glow />
        </header>

        {/* ---------- ACCUEIL ---------- */}
        {screen === "home" && (
          <div className="jjd-in" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <p style={{ margin: 0, textAlign: "center", fontSize: 16, opacity: .8, lineHeight: 1.5 }}>
              Trois films s'affichent au générique. À vous de nommer l'acteur qui les a tous tournés.
            </p>

            <section>
              <div style={{ fontSize: 11, letterSpacing: ".3em", textTransform: "uppercase",
                            color: C.gold, marginBottom: 8 }}>Catégorie</div>
              <div style={{ display: "grid", gap: 8 }}>
                {CATEGORIES.map((c) => (
                  <Pill key={c.id} active={category === c.id} onClick={() => setCategory(c.id)}>
                    {c.label}
                  </Pill>
                ))}
              </div>
            </section>

            {activeCat.noDiff ? (
              <p style={{ margin: 0, textAlign: "center", fontSize: 14, opacity: .6,
                          lineHeight: 1.5, padding: "0 8px" }}>
                Cette catégorie réunit tous les niveaux : les acteurs y sont
                trop peu nombreux pour être répartis.
              </p>
            ) : (
              <section>
                <div style={{ fontSize: 11, letterSpacing: ".3em", textTransform: "uppercase",
                              color: C.gold, marginBottom: 8 }}>Difficulté</div>
                <div style={{ display: "grid", gap: 8 }}>
                  {DIFFICULTIES.map((d) => (
                    <Pill key={d.id} active={difficulty === d.id} sub={d.note}
                          onClick={() => setDifficulty(d.id)}>
                      {d.label}
                    </Pill>
                  ))}
                </div>
              </section>
            )}

            <button className="jjd-btn" style={goldBtn} onClick={start}
                    disabled={activePool.length === 0}>
              Lancer la projection
            </button>
            <div style={{ textAlign: "center", fontSize: 13, opacity: .55, marginTop: -10 }}>
              {activePool.length} acteurs dans cette sélection
            </div>
            <button className="jjd-btn" style={ghostBtn} onClick={() => setScreen("board")}>
              Classement
            </button>
          </div>
        )}

        {/* ---------- JEU ---------- */}
        {screen === "play" && current && (
          <div className="jjd-in" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                          fontSize: 13, letterSpacing: ".1em", textTransform: "uppercase" }}>
              <Lives n={lives} />
              <div style={{ display: "flex", gap: 16, alignItems: "baseline" }}>
                {streak >= 2 && <span style={{ color: C.goldLight }}>Série {streak}</span>}
                <span><span style={{ opacity: .5 }}>Score </span>
                  <strong style={{ color: C.goldLight, fontSize: 17 }}>{score}</strong></span>
              </div>
            </div>

            <div className="jjd-ticket" style={{
              position: "relative", background: C.velvet, borderRadius: 4,
              padding: "26px 30px", boxShadow: "0 10px 30px #0008",
              borderTop: `2px solid ${C.gold}`, borderBottom: `2px solid ${C.gold}` }}>
              <div style={{ fontSize: 11, letterSpacing: ".34em", textTransform: "uppercase",
                            color: C.goldLight, textAlign: "center", marginBottom: 16, opacity: .85 }}>
                A joué dans
              </div>
              {current.regions.length > 1 && (
                <div style={{ textAlign: "center", marginTop: -8, marginBottom: 16 }}>
                  <span style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase",
                                 color: C.goldLight, opacity: .75, border: `1px solid ${C.gold}66`,
                                 borderRadius: 99, padding: "3px 11px" }}>
                    ✦ Double nationalité
                  </span>
                </div>
              )}
              <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
                {shownFilms.map((f, i) => (
                  <li key={f.t + f.y} className={i >= 3 ? "jjd-in" : ""}
                      style={{ display: "flex", justifyContent: "space-between",
                               alignItems: "baseline", gap: 12,
                               borderBottom: i < shownFilms.length - 1 ? "1px solid #ffffff1f" : "none",
                               paddingBottom: i < shownFilms.length - 1 ? 12 : 0 }}>
                    <span style={{ fontSize: 18, letterSpacing: ".04em", textTransform: "uppercase",
                                   fontWeight: 500, lineHeight: 1.2 }}>{filmTitle(f)}</span>
                    <span style={{ color: C.goldLight, fontSize: 15, flexShrink: 0 }}>{filmYear(f)}</span>
                  </li>
                ))}
              </ol>
              {hints >= 2 && (
                <div className="jjd-in" style={{ marginTop: 18, textAlign: "center",
                     borderTop: `1px solid ${C.gold}55`, paddingTop: 14 }}>
                  <span style={{ fontSize: 11, letterSpacing: ".3em", textTransform: "uppercase",
                                 opacity: .6, display: "block", marginBottom: 4 }}>Initiales</span>
                  <span className="display" style={{ fontSize: 24, color: C.goldLight,
                                 lineHeight: 1.6, wordBreak: "break-word" }}>
                    {maskedName(current.name)}
                  </span>
                </div>
              )}
            </div>

            <div className={wrong ? "jjd-shake" : ""} style={{ display: "flex", gap: 8 }}>
              <input
                ref={inputRef} value={guess} onChange={(e) => setGuess(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="Nom de l'acteur" aria-label="Nom de l'acteur"
                autoComplete="off" spellCheck="false"
                style={{ flex: 1, background: "#00000040", color: C.cream,
                         border: `1px solid ${wrong ? "#E4726A" : "#ffffff33"}`,
                         borderRadius: 3, padding: "13px 14px", fontSize: 17,
                         letterSpacing: ".03em", minWidth: 0 }} />
              <button className="jjd-btn" onClick={submit} disabled={!guess.trim()}
                style={{ background: `linear-gradient(180deg, ${C.goldLight}, ${C.gold})`,
                         color: C.deep, borderRadius: 3, padding: "0 22px",
                         fontSize: 15, fontWeight: 600, letterSpacing: ".1em",
                         textTransform: "uppercase" }}>
                Valider
              </button>
            </div>
            <div style={{ fontSize: 13, opacity: .5, marginTop: -10 }}>
              L'orthographe approximative est acceptée. Une erreur coûte une vie.
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button className="jjd-btn" style={ghostBtn} onClick={() => setHints((h) => h + 1)}
                      disabled={hints >= 2}>
                {hints === 0 ? "Indice · +2 films" : hints === 1 ? "Indice · initiales" : "Plus d'indice"}
                <span style={{ display: "block", fontSize: 11, opacity: .6, textTransform: "none",
                               letterSpacing: 0, marginTop: 2 }}>
                  {hints >= 2 ? "—" : `La réponse vaudra ${2 - hints} pt${2 - hints > 1 ? "s" : ""}`}
                </span>
              </button>
              <button className="jjd-btn" style={ghostBtn} onClick={skip}>
                Passer
                <span style={{ display: "block", fontSize: 11, opacity: .6, textTransform: "none",
                               letterSpacing: 0, marginTop: 2 }}>Coûte 1 vie</span>
              </button>
            </div>
          </div>
        )}

        {/* ---------- RÉVÉLATION ---------- */}
        {screen === "reveal" && reveal && (
          <div className="jjd-in" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, letterSpacing: ".34em", textTransform: "uppercase",
                            color: reveal.outcome === "trouve" ? C.goldLight : "#E4726A" }}>
                {reveal.outcome === "trouve" ? "Bonne réponse"
                  : reveal.outcome === "passe" ? "Acteur passé" : "Manqué"}
              </div>
              <div style={{ display: "flex", justifyContent: "center", margin: "16px 0 2px" }}>
                <Portrait actor={reveal.actor} />
              </div>
              <h2 className="display" style={{ margin: "10px 0 0", fontSize: 34, fontWeight: 400,
                                               color: C.cream, lineHeight: 1.15 }}>
                {reveal.actor.name}
              </h2>
              {reveal.outcome === "trouve" && (
                <div style={{ marginTop: 8, fontSize: 16, color: C.goldLight }}>
                  +{reveal.points} pt{reveal.points > 1 ? "s" : ""}
                  {reveal.bonus > 0 && ` · +${reveal.bonus} série de ${STREAK_STEP}`}
                </div>
              )}
            </div>

            <div style={{ background: "#00000033", borderRadius: 4, padding: "18px 20px",
                          border: "1px solid #ffffff1a" }}>
              <div style={{ fontSize: 11, letterSpacing: ".3em", textTransform: "uppercase",
                            color: C.gold, marginBottom: 12 }}>Filmographie</div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 9 }}>
                {reveal.actor.films.slice(0, 5).map((f, i) => {
                  const wasShown = i < reveal.shown;
                  return (
                    <li key={f.t + f.y} style={{ display: "flex", justifyContent: "space-between",
                         gap: 12, fontSize: 16, opacity: wasShown ? .45 : 1 }}>
                      <span style={{ textTransform: "uppercase", letterSpacing: ".03em" }}>
                        {!wasShown && <span style={{ color: C.gold, marginRight: 8 }}>◆</span>}
                        {filmTitle(f)}
                      </span>
                      <span style={{ color: wasShown ? "inherit" : C.goldLight, flexShrink: 0 }}>{filmYear(f)}</span>
                    </li>
                  );
                })}
              </ul>
              {reveal.shown < 5 && (
                <div style={{ fontSize: 12, opacity: .45, marginTop: 14 }}>
                  ◆ Films que l'indice aurait révélés
                </div>
              )}
            </div>

            <button className="jjd-btn" style={goldBtn} onClick={afterReveal}>
              {lives <= 0 ? "Voir le résultat" : "Acteur suivant"}
            </button>
          </div>
        )}

        {/* ---------- FIN DE PARTIE ---------- */}
        {screen === "over" && (
          <div className="jjd-in" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
                <Oscar size={46} glow />
              </div>
              <div style={{ fontSize: 11, letterSpacing: ".34em", textTransform: "uppercase",
                            opacity: .6 }}>Générique de fin</div>
              <div className="display" style={{ fontSize: 60, color: C.goldLight, lineHeight: 1.1,
                                                marginTop: 6 }}>{score}</div>
              <div style={{ fontSize: 15, opacity: .75, marginTop: 4 }}>
                {found} acteur{found > 1 ? "s" : ""} trouvé{found > 1 ? "s" : ""} · meilleure série {best}
              </div>
              <div style={{ fontSize: 13, opacity: .5, marginTop: 6 }}>{catLabel} · {difLabel}</div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <input value={pseudo} onChange={(e) => setPseudo(e.target.value)}
                     onKeyDown={(e) => e.key === "Enter" && saveScore()}
                     placeholder="Votre pseudo" aria-label="Votre pseudo" maxLength={16}
                     style={{ flex: 1, background: "#00000040", color: C.cream,
                              border: "1px solid #ffffff33", borderRadius: 3,
                              padding: "13px 14px", fontSize: 16, minWidth: 0 }} />
              <button className="jjd-btn" onClick={saveScore}
                style={{ background: `linear-gradient(180deg, ${C.goldLight}, ${C.gold})`,
                         color: C.deep, borderRadius: 3, padding: "0 20px", fontSize: 14,
                         fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase" }}>
                Publier
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button className="jjd-btn" style={ghostBtn} onClick={start}>Rejouer</button>
              <button className="jjd-btn" style={ghostBtn} onClick={() => setScreen("home")}>Accueil</button>
            </div>
          </div>
        )}

        {/* ---------- CLASSEMENT ---------- */}
        {screen === "board" && (
          <div className="jjd-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ fontSize: 11, letterSpacing: ".3em", textTransform: "uppercase",
                          color: C.gold, textAlign: "center" }}>Classement</div>
            {board.length === 0 ? (
              <p style={{ textAlign: "center", opacity: .6, fontSize: 16, lineHeight: 1.5 }}>
                Aucun score pour l'instant. Jouez une partie pour ouvrir le palmarès.
              </p>
            ) : (
              <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                {board.map((e, i) => (
                  <li key={i} style={{ display: "flex", alignItems: "center", gap: 12,
                       background: i === 0 ? "#ffffff14" : "#00000030", borderRadius: 3,
                       padding: "11px 14px", border: i === 0 ? `1px solid ${C.gold}66` : "1px solid transparent" }}>
                    <span className="display" style={{ width: 26, color: C.gold, fontSize: 18 }}>{i + 1}</span>
                    <span style={{ flex: 1, fontSize: 17, letterSpacing: ".03em" }}>{e.pseudo}</span>
                    <span style={{ fontSize: 12, opacity: .5, textTransform: "uppercase",
                                   letterSpacing: ".08em" }}>{e.difficulte}</span>
                    <span className="display" style={{ color: C.goldLight, fontSize: 20 }}>{e.score}</span>
                  </li>
                ))}
              </ol>
            )}
            <button className="jjd-btn" style={ghostBtn} onClick={() => setScreen("home")}>Retour</button>
          </div>
        )}
      </div>
    </div>
  );
}
