// Génère des JSON compacts (classements, historique de rang, tournois) pour ATP & WTA
// à partir de l'API BallDontLie. Node 18+. Clé via variable d'env BALLDONTLIE_KEY.
//
// Sorties :
//   players/{tour}/{slug}.json      → { name, country, current, history: { official: [{date,rank}] } }
//   rankings/{tour}/{season}.json   → [ { rank, player, country, points, wkMove, ytd,
//                                         wins, losses, winPct, titles, setWinPct, setMargin,
//                                         elo, sos, ao, rg, wimbledon, uso } ]
//   tournaments/{tour}/{season}.json→ [ { name, category, surface, location, country, start,
//                                         end, winner, prize } ]  (end/winner/prize si fournis)
//   momentum/{tour}/{season}.json   → { risers:[…], fallers:[…] } (vs-Expected + W-L 20 derniers + rangΔ)
//
// BASE (BallDontLie, gratuit) : rank/player/country/points + wkMove (mouvement) + ytd (Δ 1er janv).
// ENRICHISSEMENT (api-tennis.com, secret API_TENNIS_KEY) : wins/losses/winPct/titles/GC/sets/elo/sos
//   via balayage get_fixtures de la saison, mergé par slug de nom + vainqueurs de tournois. Ignoré
//   proprement si la clé est absente. Alternative payante BallDontLie /matches sous ENRICH_MATCHES=1.
//   Tout en try/catch : ne casse jamais la sortie de base.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const KEY = process.env.BALLDONTLIE_KEY
const BASE = 'https://api.balldontlie.io'   // API tennis ATP/WTA (base rankings/history/tournois)
const SEASON = new Date().getFullYear()
const MAX_PLAYER_FILES = 400

// Source d'ENRICHISSEMENT (V/D, GC, sets, ELO, SOS, vainqueurs de tournois) : api-tennis.com.
// Clé = secret GitHub Action API_TENNIS_KEY (jamais en clair). Absente → enrichissement ignoré.
const APT_KEY = process.env.API_TENNIS_KEY
const APT_BASE = 'https://api.api-tennis.com/tennis/'

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(path, params = {}) {
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v)
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, { headers: { Authorization: KEY } })
    if (res.status === 429) { await sleep(2500 * (attempt + 1)); continue }   // BallDontLie strict → backoff patient
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path} ${await res.text().catch(() => '')}`.slice(0, 200))
    return res.json()
  }
  throw new Error(`429 répété sur ${path}`)
}
async function apiAll(path, params = {}) {   // suit meta.next_cursor
  let cursor, out = []
  do {
    const j = await api(path, { ...params, per_page: 100, cursor })
    out.push(...(j.data ?? []))
    cursor = j.meta?.next_cursor ?? j.meta?.next_page
    await sleep(900)
  } while (cursor)
  return out
}

// Champs tolérants (on ne connaît pas 100% le schéma → plusieurs alias).
function pName(p) {
  if (!p) return ''
  if (p.name) return String(p.name).trim()
  return `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
}
function pCountry(p) { return p?.country_code || p?.country || p?.ioc || undefined }
function rRank(r) { return Number(r.rank ?? r.position ?? r.ranking) }
function rPoints(r) { return Number(r.points ?? r.ranking_points) || undefined }
function slug(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
// Clé de matching entre sources : api-tennis abrège le prénom (« J. Sinner ») tandis que
// BallDontLie donne le nom complet (« Jannik Sinner »). On matche sur NOM + INITIALE du prénom :
// « sinner|j ». On joint tout sauf le prénom (gère « de Minaur », « Auger-Aliassime »).
function matchKey(name) {
  const parts = String(name || '').replace(/\./g, ' ').trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return slug(name || '')
  const initial = (parts[0][0] || '').toLowerCase()
  const last = slug(parts.slice(1).join('-'))
  return `${last}|${initial}`
}
async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(data))
}

// Dates ~mensuelles de 2025-01 à aujourd'hui (points de l'historique de rang).
function historyDates() {
  const out = []
  const now = new Date()
  for (let y = 2025; y <= now.getFullYear(); y++) {
    for (let m = 0; m < 12; m++) {
      const d = new Date(Date.UTC(y, m, 1))
      if (d > now) break
      out.push(d.toISOString().slice(0, 10))
    }
  }
  out.push(now.toISOString().slice(0, 10))   // + aujourd'hui
  return [...new Set(out)]
}

// ── Enrichissement (stats saison calculées depuis /{tour}/v1/matches) ────────────
const GS = [
  { key: 'ao',        re: /australian open/i },
  { key: 'rg',        re: /roland|french open/i },
  { key: 'wimbledon', re: /wimbledon/i },
  { key: 'uso',       re: /us open/i },
]
const ROUND_ORDER = { W: 8, F: 7, SF: 6, QF: 5, R16: 4, R32: 3, R64: 2, R128: 1 }
// Normalise un libellé de tour → code. Gère : « Final », « Semi-final », « Quarterfinals »,
// « Round of 16 », « R16 », et les fractions api-tennis « 1/2 » (SF) « 1/4 » (QF) « 1/8 » (R16)
// « 1/16 » (R32) « 1/32 » (R64) « 1/64 » (R128).
function normRound(round) {
  if (round == null) return null
  const s = String(round).trim().toLowerCase()
  if (!s) return null
  if (/final/.test(s) && !/semi|quarter|round|1\/\d/.test(s)) return 'F'
  if (/semi|1\/2(?!\d)/.test(s)) return 'SF'
  if (/quarter|1\/4(?!\d)/.test(s)) return 'QF'
  const frac = s.match(/1\/(\d+)/)
  if (frac) { const n = Number(frac[1]); return n === 2 ? 'SF' : n === 4 ? 'QF' : `R${n * 2}` }
  const rof = s.match(/round of\s*(\d+)/)
  if (rof) return `R${rof[1]}`
  const rc = s.match(/^r\.?\s*(\d+)$/)
  if (rc) return `R${rc[1]}`
  return null
}
function pid(x) { return x == null ? null : (typeof x === 'object' ? (x.id ?? null) : x) }
// Identifie le vainqueur : objet/id direct, ou entier 1/2 = player1/player2.
function winnerId(m, id1, id2) {
  const w = m.winner
  if (w == null) return null
  if (typeof w === 'object') return w.id ?? null
  if (w === 1 || w === '1') return id1
  if (w === 2 || w === '2') return id2
  const n = Number(w)
  return Number.isFinite(n) ? n : null
}
// Variation de rang hebdo (mouvement du classement) → nombre signé (+ = progression).
function parseMove(mv) {
  if (mv == null || mv === '') return undefined
  if (typeof mv === 'number') return mv
  const s = String(mv).trim().toLowerCase()
  if (['same', '0', '-', '=', '–'].includes(s)) return 0
  const n = Number(s.replace(/[^0-9]/g, ''))
  if (Number.isFinite(n) && n > 0) return /down|▼|↓|-/.test(s) ? -n : n
  if (/up|▲|↑/.test(s)) return 1
  if (/down|▼|↓/.test(s)) return -1
  return 0
}

// Calcule les stats saison par joueur (id → objet) depuis tous les matchs de la saison.
async function enrichFromMatches(tour, season, tStartById) {
  let matches = await apiAll(`/${tour}/v1/matches`, { 'seasons[]': season })
  if (!matches.length) matches = await apiAll(`/${tour}/v1/matches`, { season })
  if (matches[0]) console.log(`  ex. match: ${JSON.stringify(matches[0]).slice(0, 260)}`)
  console.log(`  matches: ${matches.length}`)
  if (!matches.length) return new Map()

  const agg = new Map()   // id → agrégats
  const get = id => agg.get(id) ?? agg.set(id, { wins: 0, losses: 0, setsW: 0, setsL: 0, gameDiff: 0, setCount: 0, titles: 0, gs: {} }).get(id)
  const ordered = []      // pour l'ELO chronologique

  for (const m of matches) {
    const t = m.tournament ?? {}
    const id1 = pid(m.player1), id2 = pid(m.player2)
    if (id1 == null || id2 == null) continue
    const wId = winnerId(m, id1, id2)
    const rnd = normRound(m.round)
    const tStart = tStartById.get(t.id) ?? ''
    ordered.push({ id1, id2, wId, ord: `${tStart}#${String(ROUND_ORDER[rnd] ?? 0).padStart(2, '0')}` })

    // Victoires / défaites
    if (wId === id1) { get(id1).wins++; get(id2).losses++ }
    else if (wId === id2) { get(id2).wins++; get(id1).losses++ }

    // Sets & jeux
    for (const ss of (m.set_scores ?? [])) {
      const g1 = Number(ss.player1_games), g2 = Number(ss.player2_games)
      if (!Number.isFinite(g1) || !Number.isFinite(g2)) continue
      const a = get(id1), b = get(id2)
      a.setCount++; b.setCount++
      a.gameDiff += (g1 - g2); b.gameDiff += (g2 - g1)
      if (g1 > g2) { a.setsW++; b.setsL++ }
      else if (g2 > g1) { b.setsW++; a.setsL++ }
      else {
        const tb1 = Number(ss.player1_tiebreak), tb2 = Number(ss.player2_tiebreak)
        if (Number.isFinite(tb1) && Number.isFinite(tb2)) {
          if (tb1 > tb2) { a.setsW++; b.setsL++ }
          else if (tb2 > tb1) { b.setsW++; a.setsL++ }
        }
      }
    }

    // Titre = finale gagnée
    if (rnd === 'F' && wId != null) get(wId).titles++

    // Meilleur résultat en Grand Chelem
    const gs = GS.find(g => g.re.test(String(t.name ?? '')))
    if (gs && rnd) {
      for (const p of [id1, id2]) {
        const code = (rnd === 'F' && wId === p) ? 'W' : rnd
        const cur = get(p).gs[gs.key]
        if (!cur || (ROUND_ORDER[code] ?? 0) > (ROUND_ORDER[cur] ?? 0)) get(p).gs[gs.key] = code
      }
    }
  }

  // ELO maison (approx.) : ordre chronologique reconstruit (date tournoi + round).
  ordered.sort((a, b) => a.ord.localeCompare(b.ord))
  const elo = new Map()
  const R = id => elo.get(id) ?? 1500
  const K = 32
  for (const w of ordered) {
    if (w.wId == null) continue
    const loser = w.wId === w.id1 ? w.id2 : (w.wId === w.id2 ? w.id1 : null)
    if (loser == null) continue
    const ra = R(w.wId), rb = R(loser)
    const ea = 1 / (1 + 10 ** ((rb - ra) / 400))
    elo.set(w.wId, ra + K * (1 - ea))
    elo.set(loser, rb - K * (1 - ea))
  }

  // SOS : ELO final moyen des adversaires → percentile 0-100 sur le champ.
  const opp = new Map()   // id → [somme, n]
  for (const w of ordered) {
    const ea = elo.get(w.id1), eb = elo.get(w.id2)
    const acc = (id, v) => { const e = opp.get(id) ?? [0, 0]; e[0] += (v ?? 1500); e[1]++; opp.set(id, e) }
    if (ea != null) acc(w.id1, eb)
    if (eb != null) acc(w.id2, ea)
  }
  const avgOpp = new Map()
  for (const [id, [s, n]] of opp) if (n) avgOpp.set(id, s / n)
  const vals = [...avgOpp.values()].sort((a, b) => a - b)
  const pct = v => vals.length < 2 ? 50 : Math.round(100 * vals.filter(x => x < v).length / (vals.length - 1))

  const out = new Map()
  for (const [id, a] of agg) {
    const played = a.wins + a.losses
    const sets = a.setsW + a.setsL
    out.set(id, {
      wins: a.wins, losses: a.losses,
      winPct: played ? +(100 * a.wins / played).toFixed(1) : undefined,
      titles: a.titles || undefined,
      setWinPct: sets ? +(100 * a.setsW / sets).toFixed(1) : undefined,
      setMargin: a.setCount ? +(a.gameDiff / a.setCount).toFixed(2) : undefined,
      elo: elo.has(id) ? Math.round(elo.get(id)) : undefined,
      sos: avgOpp.has(id) ? pct(avgOpp.get(id)) : undefined,
      ao: a.gs.ao, rg: a.gs.rg, wimbledon: a.gs.wimbledon, uso: a.gs.uso,
    })
  }
  return out
}

// ── ENRICHISSEMENT api-tennis.com ────────────────────────────────────────────────
async function apt(method, params = {}) {
  const url = new URL(APT_BASE)
  url.searchParams.set('method', method)
  url.searchParams.set('APIkey', APT_KEY)
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v))
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url)
    if (res.status === 429 || res.status >= 500) { await sleep(1200 * (attempt + 1)); continue }   // retry 429 ET 5xx
    if (!res.ok) throw new Error(`APT ${res.status} ${method}`)
    const j = await res.json().catch(() => ({}))
    if (!Array.isArray(j.result)) { console.warn(`  apt ${method}: réponse sans result[] → ${JSON.stringify(j).slice(0, 160)}`); return [] }
    return j.result
  }
  throw new Error(`APT ${method} — échec répété (429/5xx)`)
}

// Récupère TOUS les fixtures (toutes tournées) de la saison N-1 + N, en chunks de 10 jours
// (les plages d'un mois font planter get_fixtures en 500). 1 seul fetch, mis en cache et
// réutilisé pour ATP et WTA (filtrés ensuite via fxCircuit).
let _aptFixtures = null
async function getSeasonFixtures(season) {
  if (_aptFixtures) return _aptFixtures
  const now = new Date()
  const out = []
  let cur = new Date(Date.UTC(season - 2, 0, 1))   // 3 saisons (N-2, N-1, N) : ELO plus profond + historique
  while (cur <= now) {
    const start = new Date(cur)
    const endD = new Date(cur); endD.setUTCDate(endD.getUTCDate() + 9)
    const e = endD > now ? now : endD
    const ds = start.toISOString().slice(0, 10), de = e.toISOString().slice(0, 10)
    try { out.push(...await apt('get_fixtures', { date_start: ds, date_stop: de, timezone: 'UTC' })) }
    catch (err) { console.warn(`  apt fixtures ${ds}..${de}: ${err.message}`) }
    await sleep(300)
    cur = new Date(cur); cur.setUTCDate(cur.getUTCDate() + 10)
  }
  if (out[0]) console.log(`  ex. apt fixture: ${JSON.stringify(out[0]).slice(0, 220)}`)
  console.log(`  api-tennis fixtures totaux (N-1+N): ${out.length}`)
  _aptFixtures = out
  return out
}

// Circuit d'un fixture api-tennis (event_type_type) → tour, pour filtrer doubles/challenger/ITF.
function fxCircuit(f) {
  const t = (f.event_type_type || '').toLowerCase()
  if (t.includes('double')) return 'dbl'
  if (t.includes('challenger')) return 'chal'
  if (t.includes('itf')) return 'itf'
  if (t.includes('wta')) return 'wta'
  return 'atp'
}

// Calcule les stats saison (V/D, GC, sets, ELO, SOS) + les vainqueurs de tournois depuis
// le balayage mensuel de get_fixtures. Agrégats indexés par SLUG DE NOM (merge sur les leaders).
async function enrichFromApiTennis(tour, season) {
  const want = tour === 'wta' ? 'wta' : 'atp'
  // Saison N-1 + N (ELO « chaud » + 20 derniers matchs fiables) ; stats de colonnes filtrées
  // sur la saison en cours. Fixtures récupérés une fois (cache), filtrés par tournée ici.
  const all = await getSeasonFixtures(season)
  const fixtures = all.filter(f => fxCircuit(f) === want)
  console.log(`  api-tennis ${tour}: ${fixtures.length} fixtures (sur ${all.length} toutes tournées)`)
  if (!fixtures.length) return { players: new Map(), tourWinners: new Map(), momentum: new Map() }

  const agg = new Map()   // slug → agrégats
  const get = name => { const s = matchKey(name); let a = agg.get(s); if (!a) { a = { name, wins: 0, losses: 0, setsW: 0, setsL: 0, gameDiff: 0, setCount: 0, titles: 0, gs: {} }; agg.set(s, a) } return a }
  const ordered = []      // pour l'ELO daté : { date, w:slug, l:slug }
  const tourWinners = new Map()

  for (const f of fixtures) {
    if (fxCircuit(f) !== want) continue
    const n1 = f.event_first_player, n2 = f.event_second_player
    if (!n1 || !n2) continue
    const s1 = matchKey(n1), s2 = matchKey(n2)
    const rnd = normRound(f.tournament_round)
    const winSlug = f.event_winner === 'First Player' ? s1 : f.event_winner === 'Second Player' ? s2 : null
    const a = get(n1), b = get(n2)   // crée les entrées (nom) pour tous — ELO/momentum toutes années
    const isCur = String(f.event_date || '').slice(0, 4) === String(season)

    // Stats de colonnes (V/D, sets, titres, GC, vainqueurs) : SAISON EN COURS uniquement.
    if (isCur) {
      if (winSlug === s1) { a.wins++; b.losses++ }
      else if (winSlug === s2) { b.wins++; a.losses++ }

      for (const sc of (f.scores ?? [])) {
        const g1 = parseInt(String(sc.score_first), 10), g2 = parseInt(String(sc.score_second), 10)
        if (!Number.isFinite(g1) || !Number.isFinite(g2)) continue
        a.setCount++; b.setCount++; a.gameDiff += (g1 - g2); b.gameDiff += (g2 - g1)
        if (g1 > g2) { a.setsW++; b.setsL++ } else if (g2 > g1) { b.setsW++; a.setsL++ }
      }

      if (rnd === 'F' && winSlug) {
        get(winSlug === s1 ? n1 : n2).titles++
        if (f.tournament_name) tourWinners.set(slug(f.tournament_name), winSlug === s1 ? n1 : n2)
      }

      const gs = GS.find(g => g.re.test(f.tournament_name || ''))
      if (gs && rnd) for (const [nm, sn] of [[n1, s1], [n2, s2]]) {
        const code = (rnd === 'F' && winSlug === sn) ? 'W' : rnd
        const cur = get(nm).gs[gs.key]
        if (!cur || (ROUND_ORDER[code] ?? 0) > (ROUND_ORDER[cur] ?? 0)) get(nm).gs[gs.key] = code
      }
    }

    // ELO + momentum : TOUTES les années balayées (ordre chronologique).
    if (winSlug) ordered.push({ date: f.event_date || '', w: winSlug, l: winSlug === s1 ? s2 : s1 })
  }

  // ELO daté (K=32) sur l'ordre chronologique réel (event_date).
  // + « vs Expected » : à chaque match, contribution = résultat réel (1/0) − proba ELO pré-match.
  ordered.sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const elo = new Map(); const R = s => elo.get(s) ?? 1500; const K = 32
  const perf = new Map()   // slug → [{ contrib, won }] chronologique (pour le momentum)
  const pushP = (s, contrib, won) => { const arr = perf.get(s) ?? []; arr.push({ contrib, won }); perf.set(s, arr) }
  for (const o of ordered) {
    const ra = R(o.w), rb = R(o.l)
    const ea = 1 / (1 + 10 ** ((rb - ra) / 400))   // proba que le vainqueur gagne
    pushP(o.w, 1 - ea, true)                        // vainqueur : réel 1 − attendu ea
    pushP(o.l, ea - 1, false)                       // perdant : réel 0 − attendu (1−ea)
    elo.set(o.w, ra + K * (1 - ea)); elo.set(o.l, rb - K * (1 - ea))
  }
  // Momentum : W-L + vs-Expected sur les 20 derniers matchs (≥15 matchs requis).
  const momentum = new Map()
  for (const [s, arr] of perf) {
    const last = arr.slice(-20)
    if (last.length < 15) continue
    const w = last.filter(e => e.won).length
    momentum.set(s, { name: agg.get(s)?.name ?? s, w20: w, l20: last.length - w, vsExpected: +last.reduce((a, e) => a + e.contrib, 0).toFixed(1) })
  }
  // SOS : ELO final moyen des adversaires → percentile 0-100.
  const opp = new Map()
  for (const o of ordered) {
    const acc = (s, v) => { const e = opp.get(s) ?? [0, 0]; e[0] += (v ?? 1500); e[1]++; opp.set(s, e) }
    acc(o.w, elo.get(o.l)); acc(o.l, elo.get(o.w))
  }
  const avgOpp = new Map()
  for (const [s, [sm, n]] of opp) if (n) avgOpp.set(s, sm / n)
  const vals = [...avgOpp.values()].sort((a, b) => a - b)
  const pct = v => vals.length < 2 ? 50 : Math.round(100 * vals.filter(x => x < v).length / (vals.length - 1))

  const players = new Map()
  for (const [s, a] of agg) {
    const played = a.wins + a.losses, sets = a.setsW + a.setsL
    players.set(s, {
      wins: a.wins, losses: a.losses,
      winPct: played ? +(100 * a.wins / played).toFixed(1) : undefined,
      titles: a.titles || undefined,
      setWinPct: sets ? +(100 * a.setsW / sets).toFixed(1) : undefined,
      setMargin: a.setCount ? +(a.gameDiff / a.setCount).toFixed(2) : undefined,
      elo: elo.has(s) ? Math.round(elo.get(s)) : undefined,
      sos: avgOpp.has(s) ? pct(avgOpp.get(s)) : undefined,
      ao: a.gs.ao, rg: a.gs.rg, wimbledon: a.gs.wimbledon, uso: a.gs.uso,
    })
  }
  return { players, tourWinners, momentum }
}

// Dotation → chaîne lisible (« $1,691,602 »). Tolère nombre brut ou chaîne déjà formatée.
function fmtPrize(v) {
  if (v == null || v === '') return undefined
  if (typeof v === 'number') return `$${v.toLocaleString('en-US')}`
  const s = String(v).trim()
  return /^\d+$/.test(s) ? `$${Number(s).toLocaleString('en-US')}` : s
}

// Récupère les tournois de la saison (utilisé pour le fichier + les dates de départ ELO).
async function fetchTournaments(tour) {
  let ts = await apiAll(`/${tour}/v1/tournaments`, { season: SEASON })
  if (ts.length === 0) { console.log(`  0 avec season=${SEASON} → réessai sans filtre`); ts = await apiAll(`/${tour}/v1/tournaments`, {}) }
  return ts
}

async function buildTour(tour) {
  const dates = historyDates()
  console.log(`[${tour}] ${dates.length} dates d'historique…`)

  const bioById = new Map()               // id → { name, country }
  const histById = new Map()              // id → [[date, rank]]
  let latest = []                         // dernière semaine (leaders)
  let firstLogged = false

  // Bio (âge/taille/poids/main) — UNIQUEMENT via /players (les rankings ne la portent pas).
  const bioFull = new Map()
  try {
    const all = await apiAll(`/${tour}/v1/players`)
    for (const pp of all) if (pp?.id != null) bioFull.set(pp.id, {
      age: pp.age ?? undefined, height: pp.height_cm ?? undefined,
      weight: pp.weight_kg ?? undefined, hand: pp.plays ?? undefined,
    })
    console.log(`  bio: ${bioFull.size} joueurs`)
  } catch (e) { console.warn(`  bio indispo: ${e.message}`) }

  for (const date of dates) {
    let rows
    try { rows = await api(`/${tour}/v1/rankings`, { date, per_page: 100 }).then(j => j.data ?? []) }
    catch (e) { console.warn(`  ${date} skip: ${e.message}`); continue }
    if (!firstLogged && rows[0]) { console.log(`  ex. row: ${JSON.stringify(rows[0]).slice(0, 220)}`); firstLogged = true }
    for (const r of rows) {
      const p = r.player ?? r
      const id = p.id ?? r.player_id
      const rk = rRank(r)
      if (id == null || !Number.isFinite(rk)) continue
      if (!bioById.has(id)) bioById.set(id, { name: pName(p), country: pCountry(p) })
      ;(histById.get(id) ?? histById.set(id, []).get(id)).push([date, rk])
    }
    latest = rows   // la dernière itération = la plus récente
    await sleep(900)
  }

  // Variation hebdo (mouvement) + Δ depuis le 1er janvier, par joueur.
  const moveById = new Map()
  for (const r of latest) {
    const p = r.player ?? r
    const id = p.id ?? r.player_id
    if (id != null) moveById.set(id, parseMove(r.movement))
  }
  const yearStart = `${SEASON}-01-01`
  function ytdFor(id, currentRank) {
    const h = histById.get(id)
    if (!h || !h.length) return undefined
    const sorted = [...h].sort((a, b) => a[0].localeCompare(b[0]))
    const first = sorted.find(([d]) => d >= yearStart) ?? sorted[0]
    return first ? first[1] - currentRank : undefined   // + = progression (rang diminué)
  }

  // Écriture des fiches joueur + collecte de la liste des leaders (avec id interne).
  let written = 0
  const leadersRaw = []
  for (const r of latest) {
    const p = r.player ?? r
    const id = p.id ?? r.player_id
    const rk = rRank(r)
    if (id == null || !Number.isFinite(rk)) continue
    const bio = bioById.get(id) ?? { name: pName(p), country: pCountry(p) }
    if (bio.name && written < MAX_PLAYER_FILES) {
      const hist = (histById.get(id) ?? []).sort((a, b) => a[0].localeCompare(b[0]))
      const fb = bioFull.get(id) ?? {}
      await writeJson(`players/${tour}/${slug(bio.name)}.json`, {
        name: bio.name, country: bio.country, current: rk,
        age: fb.age, height: fb.height, weight: fb.weight, hand: fb.hand,
        history: { official: hist.map(([d, rank]) => ({ date: d, rank })) },
      })
      written++
    }
    leadersRaw.push({ id, rank: rk, player: bio.name, country: bio.country, points: rPoints(r) })
  }
  console.log(`  → ${written} fiches joueur, ${leadersRaw.length} leaders`)

  // Tournois (fichier + carte des dates de départ pour l'ELO).
  let tournaments = []
  const tStartById = new Map()
  try {
    const ts = await fetchTournaments(tour)
    console.log(`  tournois reçus: ${ts.length}${ts[0] ? ` · ex: ${JSON.stringify(ts[0]).slice(0, 240)}` : ''}`)
    for (const t of ts) { const s = t.start_date ?? t.start ?? t.date; if (t.id != null && s) tStartById.set(t.id, String(s)) }
    tournaments = ts.map(t => ({
      name: t.name ?? t.title, category: t.category ?? t.level, surface: t.surface,
      location: t.location ?? t.city, country: t.country ?? t.country_code,
      start: t.start_date ?? t.start ?? t.date,
      end: t.end_date ?? t.end ?? undefined,
      winner: (typeof t.winner === 'object' ? (t.winner?.name ?? undefined) : t.winner) ?? t.champion ?? undefined,
      prize: fmtPrize(t.prize_money ?? t.prizeMoney ?? t.prize),
    })).sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')))
  } catch (e) { console.warn(`  tournois indisponibles: ${e.message}`) }

  // ENRICHISSEMENT api-tennis (source choisie) : V/D, GC, sets, ELO, SOS par slug de nom
  // + vainqueurs de tournois. try/catch = ne casse jamais la sortie de base.
  let aptPlayers = new Map(), tourWinners = new Map(), momentumMap = new Map()
  if (APT_KEY) {
    try {
      const r = await enrichFromApiTennis(tour, SEASON)
      aptPlayers = r.players; tourWinners = r.tourWinners; momentumMap = r.momentum
      console.log(`  api-tennis: ${aptPlayers.size} joueurs enrichis · ${tourWinners.size} vainqueurs · ${momentumMap.size} momentum`)
    } catch (e) { console.warn(`  api-tennis indisponible: ${e.message}`) }
  } else {
    console.log('  API_TENNIS_KEY absent — enrichissement api-tennis ignoré (WK±/YTD gratuits seuls)')
  }

  // Alternative PAYANTE BallDontLie /matches (ALL-STAR), si explicitement activée.
  let bdlEnrich = new Map()
  if (process.env.ENRICH_MATCHES === '1') {
    try { bdlEnrich = await enrichFromMatches(tour, SEASON, tStartById); console.log(`  BDL matches: ${bdlEnrich.size} joueurs`) }
    catch (e) { console.warn(`  BDL matches indisponible: ${e.message}`) }
  }

  // Injecte les vainqueurs api-tennis dans les tournois (colonne « Vainqueur »).
  for (const t of tournaments) if (!t.winner && t.name) { const w = tourWinners.get(slug(t.name)); if (w) t.winner = w }

  // Fusion → fichier rankings final (api-tennis par clé nom+initiale ; fallback BDL par id).
  const leaders = leadersRaw.slice(0, 100).map(l => {
    const e = aptPlayers.get(matchKey(l.player)) ?? bdlEnrich.get(l.id) ?? {}
    const row = {
      rank: l.rank, player: l.player, country: l.country, points: l.points,
      wkMove: moveById.get(l.id), ytd: ytdFor(l.id, l.rank),
      ...e,
    }
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k]
    return row
  })
  await writeJson(`rankings/${tour}/${SEASON}.json`, leaders)
  await writeJson(`tournaments/${tour}/${SEASON}.json`, tournaments)
  console.log(`  → rankings/${tour}/${SEASON}.json (${leaders.length}) · tournaments (${tournaments.length})`)

  // Momentum index (risers/fallers) : vs-Expected + rangΔ 60j. Pays/rang/nom via l'historique
  // BallDontLie, indexé par la MÊME clé nom+initiale que le momentum (noms abrégés api-tennis).
  if (momentumMap.size) {
    const kCountry = new Map(), kRank60 = new Map(), kRankNow = new Map(), kName = new Map()
    for (const l of leadersRaw) kRankNow.set(matchKey(l.player), l.rank)
    const target60 = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10)
    for (const [id, b] of bioById) {
      if (!b.name) continue
      const s = matchKey(b.name)
      kName.set(s, b.name)                       // nom complet BallDontLie (pour l'affichage)
      if (b.country) kCountry.set(s, b.country)
      const h = histById.get(id)
      if (h && h.length) {
        const sorted = [...h].sort((a, b) => a[0].localeCompare(b[0]))
        let r60
        for (const [d, rk] of sorted) { if (d <= target60) r60 = rk; else break }
        kRank60.set(s, r60 ?? sorted[0][1])
      }
    }
    const rows = []
    for (const [s, m] of momentumMap) {
      const rankNow = kRankNow.get(s), r60 = kRank60.get(s)
      rows.push({ player: kName.get(s) ?? m.name, country: kCountry.get(s), w: m.w20, l: m.l20, vsExpected: m.vsExpected, rankDelta: (rankNow != null && r60 != null) ? (r60 - rankNow) : undefined })
    }
    rows.sort((a, b) => b.vsExpected - a.vsExpected)
    const risers = rows.slice(0, 15)
    const fallers = rows.slice(-15).reverse()
    await writeJson(`momentum/${tour}/${SEASON}.json`, { risers, fallers })
    console.log(`  → momentum/${tour}/${SEASON}.json (${rows.length} joueurs)`)
  }

  // Index de noms (résolution « E. Mertens » → « Elise Mertens ») : tous les joueurs vus.
  const index = [...bioById.values()]
    .filter(b => b.name)
    .map(b => ({ slug: slug(b.name), name: b.name, country: b.country }))
  await writeJson(`index/${tour}.json`, index)
  console.log(`  → index/${tour}.json (${index.length})`)
}

if (!KEY) { console.error('BALLDONTLIE_KEY manquant (secret).'); process.exit(1) }
for (const tour of ['atp', 'wta']) {
  await buildTour(tour).catch(e => console.error(`[${tour}] ÉCHEC — ${e.message}`))
}
console.log('Terminé.')
