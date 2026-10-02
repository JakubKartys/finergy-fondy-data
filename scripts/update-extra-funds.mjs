#!/usr/bin/env node
// Downloads funds missing from data/fondy.xml (Conseq platform, INVESTIKA) including price history.
// Usage: node scripts/update-extra-funds.mjs   →   writes data/fondy-extra.json
import { readFileSync, writeFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'

const ROOT = new URL('..', import.meta.url)
const OUT = new URL('data/fondy-extra.json', ROOT)
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; FinergyPortfolio/1.0)' }
const CONCURRENCY = 4

// ─── helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchRetry(url, init = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { ...UA, ...init.headers } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`)
      await sleep(1000 * i)
    }
  }
}

async function pool(items, worker) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await worker(items[i], i)
      }
    }),
  )
  return results
}

const decode = (s) =>
  s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const text = (html) => decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim()
const czNum = (s) => {
  const v = parseFloat(String(s).replace(/\s|%/g, '').replace(',', '.'))
  return Number.isFinite(v) ? v : null
}
const czDate = (s) => {
  const m = String(s).match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/)
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null
}
const excelDate = (serial) => new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(serial)) * 86_400_000).toISOString().slice(0, 10)

function xlsxRows(buf) {
  const files = unzipSync(new Uint8Array(buf))
  const shared = []
  const sst = files['xl/sharedStrings.xml'] && strFromU8(files['xl/sharedStrings.xml'])
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')))
  const sheetName = Object.keys(files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort()[0]
  const sheet = strFromU8(files[sheetName])
  const rows = []
  for (const r of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = []
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const t = c[1].match(/\bt="([^"]*)"/)?.[1]
      const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? ''
      row.push(t === 's' ? shared[Number(v)] ?? '' : decode(v))
    }
    rows.push(row)
  }
  return rows
}

const weekKey = (iso) => Math.floor(Date.parse(iso) / (7 * 86_400_000))

/** Keeps the last price of every week for the last ~13 months and of every month before that. */
function downsample(points) {
  const sorted = [...points].sort((a, b) => a[0].localeCompare(b[0]))
  if (!sorted.length) return sorted
  const recentFrom = new Date(Date.parse(sorted[sorted.length - 1][0]) - 400 * 86_400_000).toISOString().slice(0, 10)
  const out = []
  for (let i = 0; i < sorted.length; i++) {
    const [d] = sorted[i]
    const next = sorted[i + 1]
    const bucketEnds = !next || (d >= recentFrom ? weekKey(next[0]) !== weekKey(d) : next[0].slice(0, 7) !== d.slice(0, 7))
    if (bucketEnds) out.push(sorted[i])
  }
  return out
}

function perfFromHistory(history) {
  const last = history[history.length - 1]
  const at = (months) => {
    const target = new Date(Date.parse(last[0]))
    target.setUTCMonth(target.getUTCMonth() - months)
    const iso = target.toISOString().slice(0, 10)
    let best = null
    for (const p of history) if (p[0] <= iso) best = p
    if (!best || Date.parse(iso) - Date.parse(best[0]) > 40 * 86_400_000) return null
    return best[1]
  }
  const cum = (m) => {
    const p = at(m)
    return p ? (last[1] / p - 1) * 100 : 0
  }
  const ann = (m) => {
    const p = at(m)
    return p ? (Math.pow(last[1] / p, 12 / m) - 1) * 100 : 0
  }
  return {
    perf1M: cum(1), perf3M: cum(3), perf6M: cum(6), perf9M: cum(9), perf1Y: cum(12),
    perf3Y: ann(36), perf5Y: ann(60), perf7Y: ann(84), perf10Y: ann(120),
  }
}

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d

// ─── existing XML funds ───────────────────────────────────────────────────────

function xmlKeys() {
  const xml = readFileSync(new URL('data/fondy.xml', ROOT), 'utf8')
  const keys = new Set()
  for (const m of xml.matchAll(/<fund\b[^>]*>/g)) {
    const tag = m[0]
    const isin = tag.match(/isin="([^"]*)"/)?.[1]
    const cur = tag.match(/currency="([^"]*)"/)?.[1]
    const nav = parseFloat(tag.match(/\bnav="([^"]*)"/)?.[1] ?? '')
    if (isin && cur && nav > 0) keys.add(`${isin}|${cur}`)
  }
  return keys
}

// ─── Conseq ───────────────────────────────────────────────────────────────────

const CONSEQ = 'https://www.conseq.cz'
const CONSEQ_LIST = `${CONSEQ}/investice/prehled-fondu`
const PAGER = 'p$lt$ctl07$pageplaceholder$p$lt$ctl05$UniversalPager$pagerElem'

const ASSET_CLASS = {
  'Akciové investice': 'EQ',
  'Dluhopisové investice': 'BOND',
  'Smíšená aktiva': 'BAL',
  'Krátkodobé investice': 'MM',
  'Nemovitostní investice': 'REAL',
  Komodity: 'COM',
  'Alternativní investice': 'ALT',
}

function partnerFromCompany(company, name) {
  const c = company.toLowerCase()
  const known = [
    ['conseq', 'Conseq'], ['amundi', 'Amundi'], ['cpr ', 'Amundi'], ['blackrock', 'BlackRock'], ['bnp', 'BNP Paribas'], ['parvest', 'BNP Paribas'],
    ['fidelity', 'Fidelity'], ['hsbc', 'HSBC'], ['credit suisse', 'Credit Suisse'], ['iad investments', 'IAD'], ['j&t', 'J&T'],
    ['franklin', 'Franklin Templeton'], ['templeton', 'Franklin Templeton'], ['allianz', 'Allianz'], ['goldman', 'Goldman Sachs'],
    ['j.p. morgan', 'J.P. Morgan'], ['jpmorgan', 'J.P. Morgan'], ['schroder', 'Schroders'], ['investika', 'INVESTIKA'],
    ['accolade', 'Accolade'], ['amista', 'AMISTA'], ['avant', 'AVANT'], ['generali', 'Generali'], ['nn ', 'NN'], ['raiffeisen', 'Raiffeisen'],
    ['erste', 'Erste'], ['čsob', 'ČSOB'], ['kb ', 'KB'], ['ninety one', 'Ninety One'], ['pimco', 'PIMCO'], ['invesco', 'Invesco'],
  ]
  for (const [k, v] of known) if (c.includes(k)) return v
  const cleaned = company
    .replace(/,?\s*(investiční společnost|investiční fond|správ\. spol|SICAV|p\.l\.c|S\.A\.|a\.\s?s\.|s\.r\.o\.|Luxembourg|Asset Management|Global Investment|Investment|Funds?|Ltd\.?|GmbH).*$/i, '')
    .trim()
  return cleaned || name.split(/\s+/)[0]
}

function parseConseqRows(html) {
  const rows = []
  for (const m of html.matchAll(/<tr class="js-fund-row" data-fundid="(\d+)">([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1])
    const [nameCell, company, assetClass, currency, , , risk, price, date] = cells.map(text)
    const perf = Object.fromEntries([...m[2].matchAll(/data-col="(Perf\w+)">([\s\S]*?)<\/td>/g)].map((p) => [p[1], czNum(text(p[2]))]))
    const [name, isin] = nameCell.split('\n').map((s) => s.trim())
    const slug = cells[0].match(/href="\/investice\/prehled-fondu\/([^"]+)"/)?.[1]
    rows.push({
      productId: m[1], slug, name, isin, company, assetClass: ASSET_CLASS[assetClass] ?? 'OTHER', currency,
      srri: Number(risk.match(/(\d)/)?.[1] ?? 0), price: czNum(price), navDate: czDate(date), perf,
    })
  }
  return rows
}

function formFields(html) {
  const fields = new URLSearchParams()
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0]
    const name = tag.match(/\bname="([^"]*)"/)?.[1]
    const type = (tag.match(/\btype="([^"]*)"/)?.[1] ?? 'text').toLowerCase()
    if (!name || ['submit', 'button', 'image', 'checkbox', 'radio', 'file'].includes(type)) continue
    fields.set(decode(name), decode(tag.match(/\bvalue="([^"]*)"/)?.[1] ?? ''))
  }
  for (const m of html.matchAll(/<select\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    fields.set(decode(m[1]), decode(m[2].match(/<option[^>]*selected[^>]*value="([^"]*)"/i)?.[1] ?? ''))
  }
  return fields
}

async function conseqListing() {
  let res = await fetchRetry(CONSEQ_LIST)
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  let html = await res.text()
  const lastPage = Math.max(1, ...[...decode(html).matchAll(/pagerElem','(\d+)'\)/g)].map((m) => Number(m[1])))
  const all = parseConseqRows(html)
  for (let page = 2; page <= lastPage; page++) {
    const body = formFields(html)
    body.set('__EVENTTARGET', PAGER)
    body.set('__EVENTARGUMENT', String(page))
    res = await fetchRetry(CONSEQ_LIST, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body })
    html = await res.text()
    const rows = parseConseqRows(html)
    if (!rows.length) throw new Error(`Conseq: stránka ${page} je prázdná`)
    all.push(...rows)
    process.stdout.write(`\rConseq přehled: ${page}/${lastPage} stránek, ${all.length} fondů`)
  }
  process.stdout.write('\n')
  return [...new Map(all.map((r) => [`${r.isin}|${r.currency}`, r])).values()]
}

async function conseqHistory(productId) {
  const res = await fetchRetry(`${CONSEQ}/Conseq/Pricehist.ashx?productid=${productId}&culture=cs-CZ`)
  const rows = xlsxRows(await res.arrayBuffer())
  return rows
    .slice(1)
    .map((r) => [/^\d+(\.\d+)?$/.test(r[0]) ? excelDate(r[0]) : czDate(r[0]), czNum(r[1])])
    .filter((p) => p[0] && p[1] > 0)
}

// ─── INVESTIKA ────────────────────────────────────────────────────────────────

// Chart class keys verified against ISIN/NAV pairs in fondy.xml (2026-09).
const INVESTIKA = [
  { fund: 63, classes: {
    MENOVEZAJISTENA: ['CZ0008477676', 'CZK', 'EFEKTIKA měnově zajištěná (CZK)'],
    MENOVENEZAJISTENA: ['CZ0008477650', 'CZK', 'EFEKTIKA měnově nezajištěná (CZK)'],
    INVESTICNIMENOVENEZAJISTENA: ['CZ0008477668', 'CZK', 'EFEKTIKA měnově nezajištěná investiční třída (CZK)'],
    INVESTICNIMENOVEZAJISTENA: ['CZ1005100592', 'CZK', 'EFEKTIKA měnově zajištěná investiční třída (CZK)'],
  }, assetClass: 'EQ', srri: 4 },
  { fund: 72, classes: {
    CZK: ['CZ0008474830', 'CZK', 'INVESTIKA realitní fond (CZK)'],
    EUR: ['CZ0008475902', 'EUR', 'INVESTIKA realitní fond (EUR)'],
    INVESTICNI: ['CZ0008476314', 'CZK', 'INVESTIKA realitní fond, investiční třída (CZK)'],
  }, assetClass: 'REAL', srri: 2 },
  { fund: 51, classes: {
    CZK: ['CZ0008477379', 'CZK', 'MONETIKA (CZK)'],
    INVESTICNI: ['CZ0008477361', 'CZK', 'MONETIKA investiční třída (CZK)'],
  }, assetClass: 'MM', srri: 1 },
  { fund: 66, classes: {
    EUR: ['CZ0008478005', 'EUR', 'EUROMONETIKA (EUR)'],
    INVESTICNI: ['CZ0008478013', 'EUR', 'EUROMONETIKA investiční třída (EUR)'],
  }, assetClass: 'MM', srri: 1 },
  { fund: 116, classes: {
    CZKMENOVEZAJISTENA: ['CZ1005100832', 'CZK', 'CRYPTONIKA měnově zajištěná (CZK)'],
    EURMENOVEZAJISTENA: ['CZ1005100840', 'EUR', 'CRYPTONIKA měnově zajištěná (EUR)'],
    CZKINVESTICNIMENOVEZAJISTENA: ['CZ1005100857', 'CZK', 'CRYPTONIKA investiční třída (CZK)'],
  }, assetClass: 'ALT', srri: 5 },
  { fund: 75, classes: {
    CZK: ['CZ0008475670', 'CZK', 'DYNAMIKA – fond unikátních příležitostí (FKI)'],
  }, assetClass: 'ALT', srri: 4 },
  { fund: 102, classes: {
    CZKMENOVENEZAJISTENA: ['CZ1005100428', 'CZK', 'METALIKA – zlatý fond, měnově nezajištěná (FKI)'],
  }, assetClass: 'COM', srri: 4 },
]

async function investikaFunds() {
  const out = []
  for (const cfg of INVESTIKA) {
    const res = await fetchRetry(`https://www.investika.cz/funds/chartdata?fund=${cfg.fund}`)
    const data = await res.json()
    for (const [key, [isin, currency, name]] of Object.entries(cfg.classes)) {
      const series = data[key]
      if (!series?.length) {
        console.warn(`INVESTIKA: chybí třída ${key} fondu ${cfg.fund}`)
        continue
      }
      const history = series.map((p) => [p.date.slice(0, 10), Number(p.price)]).filter((p) => p[1] > 0)
      out.push({ provider: 'investika', isin, currency, name, partner: 'INVESTIKA', assetClass: cfg.assetClass, srri: cfg.srri, history })
    }
  }
  return out
}

// ─── main ─────────────────────────────────────────────────────────────────────

const known = xmlKeys()
const funds = []

const investika = await investikaFunds()
console.log(`INVESTIKA: ${investika.length} tříd fondů`)
funds.push(...investika)

const listing = await conseqListing()
const missing = listing.filter((r) => !known.has(`${r.isin}|${r.currency}`) && !funds.some((f) => f.isin === r.isin && f.currency === r.currency))
console.log(`Conseq: ${listing.length} fondů, v XML chybí ${missing.length}`)

let done = 0
const failed = []
const conseqFunds = await pool(missing, async (r) => {
  let history = []
  try {
    history = await conseqHistory(r.productId)
  } catch (e) {
    failed.push(`${r.name}: ${e.message}`)
  }
  if (!history.length && r.price && r.navDate) history = [[r.navDate, r.price]]
  process.stdout.write(`\rConseq historie: ${++done}/${missing.length}`)
  return {
    provider: 'conseq', isin: r.isin, currency: r.currency, name: r.name, partner: partnerFromCompany(r.company, r.name),
    assetClass: r.assetClass, srri: r.srri, history,
  }
})
process.stdout.write('\n')
funds.push(...conseqFunds.filter((f) => f.history.length))

const outFunds = funds
  .map((f) => {
    const history = downsample(f.history).map(([d, p]) => [d, round(p, 6)])
    const [navDate, nav] = history[history.length - 1]
    const perf = Object.fromEntries(Object.entries(perfFromHistory(history)).map(([k, v]) => [k, round(v, 3)]))
    return { ...f, inXml: known.has(`${f.isin}|${f.currency}`), nav, navDate, ...perf, history }
  })
  .sort((a, b) => `${a.isin}|${a.currency}`.localeCompare(`${b.isin}|${b.currency}`))

// Stable content (no run timestamp, one fund per line) so unchanged data produces no diff.
const dataDate = outFunds.reduce((max, f) => (f.navDate > max ? f.navDate : max), '')
const json = `{"dataDate":${JSON.stringify(dataDate)},"funds":[\n${outFunds.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`
writeFileSync(OUT, json)
console.log(`Uloženo ${outFunds.length} fondů do data/fondy-extra.json (${(json.length / 1024).toFixed(0)} kB, ceny k ${dataDate})`)
if (failed.length) console.warn(`Bez historie (${failed.length}):\n  ${failed.slice(0, 20).join('\n  ')}`)
