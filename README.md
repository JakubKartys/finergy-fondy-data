# Data fondů pro Finergy Club Portfolio

Veřejné ceny a výkonnost investičních fondů, které aplikace Finergy Club Portfolio načítá při každém spuštění.
Repozitář neobsahuje žádná data klientů.

| Soubor | Obsah | Zdroj |
|---|---|---|
| `data/fondy.xml` | ~2 500 fondů a ETF (cena, výkonnost, riziko) | [EIC – seznam fondů](https://old.eic.eu/cz/fondy/) |
| `data/fondy-extra.json` | fondy z platformy Conseq, které v XML chybí, a třídy fondů INVESTIKA, včetně historie cen | conseq.cz, investika.cz |

Data aktualizuje GitHub Action [`update.yml`](.github/workflows/update.yml) dvakrát denně a uloží je jen tehdy, když se ceny změnily.
Ručně: `npm ci && npm run update`.
