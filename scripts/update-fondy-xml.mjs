#!/usr/bin/env node
// Downloads the fund list from EIC and replaces data/fondy.xml, but only if the download looks valid.
// Usage: node scripts/update-fondy-xml.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const SOURCE = 'https://old.eic.eu/fondy/fondy.xml?download=1'
const OUT = new URL('../data/fondy.xml', import.meta.url)
const MIN_FUNDS = 1000

async function download(tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(SOURCE, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinergyPortfolio/1.0)' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (e) {
      if (i >= tries) throw new Error(`Stažení ${SOURCE} selhalo: ${e.message}`)
      await new Promise((r) => setTimeout(r, 2000 * i))
    }
  }
}

const countFunds = (xml) => (xml.match(/<fund\s/g) ?? []).length

const xml = await download()
if (!xml.trimStart().startsWith('<?xml') || !xml.includes('<funds')) {
  throw new Error('Odpověď není XML se seznamem fondů — soubor ponechán beze změny.')
}
const count = countFunds(xml)
const previous = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
const previousCount = countFunds(previous)
if (count < MIN_FUNDS || (previousCount && count < previousCount * 0.8)) {
  throw new Error(`Podezřele málo fondů (${count}, dříve ${previousCount}) — soubor ponechán beze změny.`)
}

const dates = [...xml.matchAll(/navDate="(\d{2})\.(\d{2})\.(\d{4})"/g)].map((m) => `${m[3]}-${m[2]}-${m[1]}`).sort()
const latest = dates[dates.length - 1] ?? '?'
if (xml === previous) {
  console.log(`fondy.xml beze změny (${count} fondů, ceny nejvýše k ${latest})`)
} else {
  writeFileSync(OUT, xml)
  console.log(`fondy.xml aktualizován: ${count} fondů, ceny nejvýše k ${latest}`)
}
