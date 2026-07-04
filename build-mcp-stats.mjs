// Agrège les stats service/retour par joueur depuis le Match Charting Project de
// Jeff Sackmann (données CC BY-NC-SA, publiques, ENCORE en ligne). Gratuit, sans clé.
//   Source : charting-{m|w}-stats-Overview.csv (1 ligne "Total" par joueur/match)
//   Sortie : stats/{atp|wta}/{slug}.json → { name, matches, firstServePct, firstWonPct,
//            secondWonPct, servePtsWonPct, returnPtsWonPct, bpSavePct, acesPerMatch, dfPerMatch }
// Node 18+. Aucune variable d'env requise.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const RAW = 'https://raw.githubusercontent.com/JeffSackmann/tennis_MatchChartingProject/master'
const MIN_MATCHES = 3

const slug = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(data))
}

// Colonnes de charting-*-stats-Overview.csv (schéma confirmé).
// match_id,player,set,serve_pts,aces,dfs,first_in,first_won,second_in,second_won,bk_pts,bp_saved,return_pts,return_pts_won,...
async function buildTour(tour, prefix) {
  const url = `${RAW}/charting-${prefix}-stats-Overview.csv`
  console.log(`[${tour}] fetch ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} sur Overview ${prefix}`)
  const text = await res.text()
  const lines = text.split(/\r?\n/)
  const header = lines[0].split(',')
  const col = (n) => header.indexOf(n)
  const iPlayer = col('player'), iSet = col('set')
  const idx = {
    serve_pts: col('serve_pts'), aces: col('aces'), dfs: col('dfs'),
    first_in: col('first_in'), first_won: col('first_won'),
    second_in: col('second_in'), second_won: col('second_won'),
    bk_pts: col('bk_pts'), bp_saved: col('bp_saved'),
    return_pts: col('return_pts'), return_pts_won: col('return_pts_won'),
  }

  const agg = new Map()   // name → { name, matches, ...sommes }
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split(',')
    if (r.length < header.length) continue
    if (r[iSet] !== 'Total') continue        // on ne prend que la ligne agrégée du match
    const name = (r[iPlayer] || '').trim()
    if (!name) continue
    const num = (k) => { const v = Number(r[idx[k]]); return Number.isFinite(v) ? v : 0 }
    let a = agg.get(name)
    if (!a) { a = { name, matches: 0, serve_pts: 0, aces: 0, dfs: 0, first_in: 0, first_won: 0, second_in: 0, second_won: 0, bk_pts: 0, bp_saved: 0, return_pts: 0, return_pts_won: 0 }; agg.set(name, a) }
    a.matches++
    for (const k of Object.keys(idx)) a[k] += num(k)
  }

  const pct = (n, d) => d > 0 ? Math.round((n / d) * 1000) / 10 : null
  let written = 0
  for (const a of agg.values()) {
    if (a.matches < MIN_MATCHES) continue
    await writeJson(`stats/${tour}/${slug(a.name)}.json`, {
      name: a.name, matches: a.matches,
      firstServePct:   pct(a.first_in, a.serve_pts),
      firstWonPct:     pct(a.first_won, a.first_in),
      secondWonPct:    pct(a.second_won, a.second_in),
      servePtsWonPct:  pct(a.first_won + a.second_won, a.serve_pts),
      returnPtsWonPct: pct(a.return_pts_won, a.return_pts),
      bpSavePct:       pct(a.bp_saved, a.bk_pts),
      acesPerMatch:    Math.round((a.aces / a.matches) * 10) / 10,
      dfPerMatch:      Math.round((a.dfs / a.matches) * 10) / 10,
    })
    written++
  }
  console.log(`  → ${written} fiches stats/${tour}/`)
}

for (const [tour, prefix] of [['atp', 'm'], ['wta', 'w']]) {
  await buildTour(tour, prefix).catch(e => console.error(`[${tour}] ÉCHEC — ${e.message}`))
}
console.log('Stats terminées.')
