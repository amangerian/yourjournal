# Your Journal

A weekly feed of new medical research, ranked for one person's interests.

**No backend.** The page talks to PubMed directly from the browser, scores results
locally, and keeps everything in `localStorage`. Host it on GitHub Pages and it works
— nothing to deploy, nothing to pay for, no shared rate limit.

```
specialties  →  subtopics  →  this-or-that  →  journals  →  weekly feed
```

## Deploying to GitHub Pages

1. Create a repo and push these files at the root (`index.html`, `app.js`, `styles.css`, `data/`).
2. **Settings → Pages → Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Wait a minute; your URL is `https://<username>.github.io/<repo>/`.

No build step. To develop locally, serve over http — browsers block `fetch` on `file://`:

```bash
python3 -m http.server 8791
```

## How the ranking works

```
score = 0.52 · topic match      (3,700 keywords behind 132 subtopics)
      + 0.14 · journal prior
      + 0.18 · axis alignment   (positive) / 0.10 (negative)
      + 0.16 · learned weights  (from this reader's own 👍👍/👍/👎)
```

The **this-or-that** stage is the part that makes this more than a keyword filter. It
doesn't ask about topics — those are settled two screens earlier. It locates the reader
on eight orthogonal axes:

| Axis | Poles |
|---|---|
| Trials vs mechanism | clinical outcomes ↔ molecular biology |
| Bedside vs computational | direct care ↔ modeling and imaging |
| Procedural vs medical | operative technique ↔ drug therapy |
| Depth vs breadth | subspecialty detail ↔ cross-cutting frameworks |
| Primary vs synthesis | new data ↔ reviews and meta-analyses |
| Confirmatory vs exploratory | definitive trials ↔ proof-of-concept |
| Adult vs pediatric | — |
| Individual vs systems | precision medicine ↔ policy and access |

Questions are templated with the reader's own subtopics, so they read concretely
("a randomized trial of a new treatment for **heart failure**") rather than abstractly.
Two cardiologists who pick identical subtopics still get different feeds.

Feedback refits per-reader log-odds term weights immediately — 👍👍 counts twice as hard
as 👍. ★ saves for later and has no effect on ranking.

## Optional: Claude re-rank

The keyword model is reliably wrong in both directions. In **Settings**, a reader can paste
their own [Anthropic API key](https://console.anthropic.com/settings/keys) to have Claude
read the top 30 abstracts and rewrite the scores with a one-line explanation each.

- The key is stored in that reader's browser only and sent directly to `api.anthropic.com`.
  Anyone with access to that device or browser profile can read it. It never touches this
  repo, GitHub, or any server of ours — because there is no server of ours.
- Roughly a few cents per issue.
- Entirely optional. Without a key the feed still works, at keyword quality.

## What you give up versus a hosted app

These are real, and none is a bug to be fixed later:

- **On-open, not weekly.** A static site can't run on a schedule. It scans when opened.
- **Per-browser, not per-person.** Laptop and phone are separate profiles. Clearing site
  data erases everything — hence the **Export profile** button. The app nags about this:
  once a reader has 3+ ratings or saves and hasn't exported in 7 days, a banner appears on
  the feed. "Not now" snoozes it for 3 days rather than dismissing it for good, because a
  permanently dismissible backup reminder is the same as no reminder.
- **No analytics.** No way to see whether anyone finished onboarding or where they dropped.

## Files

```
index.html          shell
app.js              everything: scoring, PubMed, storage, views
styles.css
data/taxonomy.json  20 specialties → 132 subtopics → 3,698 keywords
data/axes.json      the 8 axes, signal phrases, question bank
data/journals.json  234 journals, each validated against PubMed's [ta] field
```

To add a specialty, subtopic, or keyword, edit `data/taxonomy.json` — no code changes.
New journals must use a valid **NLM title abbreviation**; a wrong one silently returns
nothing forever, so check it at
`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term="<abbrev>"[ta]&retmax=0&retmode=json`
before adding it.

## Privacy

No accounts, no cookies, no tracking, no server. Reading history, ratings, and any API key
live in `localStorage` on the reader's own device. PubMed sees ordinary API requests from
the reader's IP; if a key is set, Anthropic sees the abstracts being ranked.
