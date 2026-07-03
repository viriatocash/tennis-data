// Génère des JSON compacts (classements, historique de rang, tournois) pour ATP & WTA
// à partir de l'API BallDontLie. Node 18+. Clé via variable d'env BALLDONTLIE_KEY.
//
// Sorties :
//   players/{tour}/{slug}.json      → { name, country, current, history: { official: [{date,rank}] } }
//   rankings/{tour}/{season}.json   → [ { rank, player, country, points } ]
//   tournaments/{tour}/{season}.json→ [ { name, category, surface, location, country, start } ]

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const KEY = process.env.BALLDONTLIE_KEY
const BASE = 'https://api.balldontlie.io'   // API tennis ATP/WTA
const SEASON = new Date().getFullYear()
const MAX_PLAYER_FILES = 400

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(path, params = {}) {
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v)
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { Authorization: KEY } })
    if (res.status === 429) { await sleep(1500 * (attempt + 1)); continue }
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
    await sleep(350)
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

async function buildTour(tour) {
  const dates = historyDates()
  console.log(`[${tour}] ${dates.length} dates d'historique…`)

  const bioById = new Map()               // id → { name, country }
  const histById = new Map()              // id → [[date, rank]]
  let latest = []                         // dernière semaine (leaders)
  let firstLogged = false

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
    await sleep(350)
  }

  let written = 0
  const leaders = []
  for (const r of latest) {
    const p = r.player ?? r
    const id = p.id ?? r.player_id
    const rk = rRank(r)
    if (id == null || !Number.isFinite(rk)) continue
    const bio = bioById.get(id) ?? { name: pName(p), country: pCountry(p) }
    if (bio.name && written < MAX_PLAYER_FILES) {
      const hist = (histById.get(id) ?? []).sort((a, b) => a[0].localeCompare(b[0]))
      await writeJson(`players/${tour}/${slug(bio.name)}.json`, {
        name: bio.name, country: bio.country, current: rk,
        history: { official: hist.map(([d, rank]) => ({ date: d, rank })) },
      })
      written++
    }
    leaders.push({ rank: rk, player: bio.name, country: bio.country, points: rPoints(r) })
  }
  console.log(`  → ${written} fiches joueur, ${leaders.length} leaders`)
  await writeJson(`rankings/${tour}/${SEASON}.json`, leaders.slice(0, 100))

  console.log(`[${tour}] tournaments ${SEASON}…`)
  try {
    const ts = await apiAll(`/${tour}/v1/tournaments`, { season: SEASON })
    const tournaments = ts.map(t => ({
      name: t.name ?? t.title, category: t.category ?? t.level, surface: t.surface,
      location: t.location ?? t.city, country: t.country ?? t.country_code,
      start: t.start_date ?? t.start ?? t.date,
    })).sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')))
    await writeJson(`tournaments/${tour}/${SEASON}.json`, tournaments)
    console.log(`  → tournaments/${tour}/${SEASON}.json (${tournaments.length})`)
  } catch (e) {
    console.warn(`  tournois indisponibles: ${e.message}`)
  }
}

if (!KEY) { console.error('BALLDONTLIE_KEY manquant (secret).'); process.exit(1) }
for (const tour of ['atp', 'wta']) {
  await buildTour(tour).catch(e => console.error(`[${tour}] ÉCHEC — ${e.message}`))
}
console.log('Terminé.')
