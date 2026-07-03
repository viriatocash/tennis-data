// Génère des JSON compacts (classements, tournois) à partir des données ouvertes de
// Jeff Sackmann (tennis_atp / tennis_wta). Node 18+. Lancer : `node build.mjs`
//
// Les CSV Sackmann sont récupérés par le workflow (actions/checkout, fiable) dans
// sackmann/{atp,wta}/ — ce script lit ces fichiers EN LOCAL (pas de fetch HTTP, que
// raw.githubusercontent rate-limite depuis les runners).
//
// Sorties :
//   players/{tour}/{slug}.json      → { name, country, current, history: { official: [{date,rank}] } }
//   rankings/{tour}/{season}.json   → [ { rank, player, country, points } ]
//   tournaments/{tour}/{season}.json→ [ { name, category, surface, start, winner } ]

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const SRC_DIR = { atp: 'sackmann/atp', wta: 'sackmann/wta' }   // lecture locale (checkout)
const SEASON = new Date().getFullYear()
const MAX_PLAYER_FILES = 600   // borne le nb de fiches joueur (taille repo)

// ── CSV ────────────────────────────────────────────────────────────────────────
function splitLine(line) {
  const out = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if (ch === ',' && !q) { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur); return out
}
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0)
  if (lines.length === 0) return []
  const headers = splitLine(lines[0])
  return lines.slice(1).map(l => {
    const c = splitLine(l); const o = {}
    headers.forEach((h, i) => { o[h] = c[i] })
    return o
  })
}
async function readFirst(dir, candidates) {
  for (const name of candidates) {
    try { const t = await readFile(join(dir, name), 'utf8'); console.log(`  ✓ ${name}`); return t }
    catch { console.log(`  · absent ${name}`) }
  }
  throw new Error(`introuvable dans ${dir}: ${candidates.join(', ')}`)
}
function slug(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
function isoDate(yyyymmdd) {
  const s = String(yyyymmdd || '')
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : ''
}
async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(data))
}

// ── Par tour ─────────────────────────────────────────────────────────────────────
async function buildTour(tour) {
  const dir = SRC_DIR[tour]
  console.log(`[${tour}] players…`)
  const players = parseCSV(await readFirst(dir, [`${tour}_players.csv`]))
  const pById = new Map()
  for (const p of players) {
    const id = p.player_id
    const name = `${p.name_first ?? ''} ${p.name_last ?? ''}`.trim()
    if (id && name) pById.set(id, { name, country: p.ioc || undefined })
  }

  console.log(`[${tour}] rankings history…`)
  const rankTexts = []
  for (const c of [[`${tour}_rankings_20s.csv`, `${tour}_rankings_2020s.csv`], [`${tour}_rankings_current.csv`]]) {
    try { rankTexts.push(await readFirst(dir, c)) } catch (e) { console.warn(`  skip: ${e.message}`) }
  }
  const rankRows = rankTexts.flatMap(parseCSV)
  const histById = new Map()
  let latestDate = ''
  for (const r of rankRows) {
    const id = r.player, date = isoDate(r.ranking_date), rank = Number(r.rank)
    if (!id || !date || !Number.isFinite(rank)) continue
    if (date > latestDate) latestDate = date
    ;(histById.get(id) ?? histById.set(id, []).get(id)).push([date, rank])
  }

  const latest = rankRows
    .filter(r => isoDate(r.ranking_date) === latestDate && Number.isFinite(Number(r.rank)))
    .sort((a, b) => Number(a.rank) - Number(b.rank))

  let written = 0
  for (const r of latest) {
    if (written >= MAX_PLAYER_FILES) break
    const id = r.player, bio = pById.get(id)
    if (!bio) continue
    const hist = (histById.get(id) ?? []).sort((a, b) => a[0].localeCompare(b[0]))
    await writeJson(`players/${tour}/${slug(bio.name)}.json`, {
      name: bio.name, country: bio.country, current: Number(r.rank),
      history: { official: hist.map(([d, rk]) => ({ date: d, rank: rk })) },
    })
    written++
  }
  console.log(`  → ${written} fiches joueur (semaine ${latestDate})`)

  const leaders = latest.slice(0, 100).map(r => {
    const bio = pById.get(r.player)
    return { rank: Number(r.rank), player: bio?.name ?? r.player, country: bio?.country, points: Number(r.points) || undefined }
  })
  await writeJson(`rankings/${tour}/${SEASON}.json`, leaders)
  console.log(`  → rankings/${tour}/${SEASON}.json (${leaders.length})`)

  console.log(`[${tour}] tournaments ${SEASON}…`)
  try {
    const matches = parseCSV(await readFirst(dir, [`${tour}_matches_${SEASON}.csv`]))
    const byTourney = new Map()
    for (const m of matches) {
      const key = m.tourney_id || m.tourney_name
      if (!key) continue
      if (!byTourney.has(key)) {
        byTourney.set(key, { name: m.tourney_name, category: m.tourney_level, surface: m.surface, start: isoDate(m.tourney_date), winner: undefined })
      }
      if ((m.round || '').toUpperCase() === 'F' && m.winner_name) byTourney.get(key).winner = m.winner_name
    }
    const tournaments = [...byTourney.values()].sort((a, b) => (a.start || '').localeCompare(b.start || ''))
    await writeJson(`tournaments/${tour}/${SEASON}.json`, tournaments)
    console.log(`  → tournaments/${tour}/${SEASON}.json (${tournaments.length})`)
  } catch (e) {
    console.warn(`  tournois indisponibles: ${e.message}`)
  }
}

for (const tour of ['atp', 'wta']) {
  await buildTour(tour).catch(e => console.error(`[${tour}] ÉCHEC — ${e.message}`))
}
console.log('Terminé.')
