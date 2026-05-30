'use strict'

const express    = require('express')
const { chromium } = require('playwright')

const PORT = process.env.PORT || 3001
const app  = express()
app.use(express.json({ limit: '120mb' }))

// ── Browser singleton — one Chromium instance serves all requests ────────────

let _browser = null

async function getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    })
    _browser.on('disconnected', () => { _browser = null })
  }
  return _browser
}

// Pre-warm browser on startup
getBrowser().catch((e) => console.error('Browser warm-up failed:', e.message))

// ── Helpers ──────────────────────────────────────────────────────────────────

// Playwright's page.pdf() accepts these format strings.
const PLAYWRIGHT_FORMATS = new Set([
  'Letter','Legal','Tabloid','Ledger',
  'A0','A1','A2','A3','A4','A5','A6',
])

// ── /health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }))

// ── /render ───────────────────────────────────────────────────────────────────
//
// POST body (JSON):
//   html        {string}  Complete self-contained HTML document to render
//   paper_size  {string}  "A4" | "A3" | "Letter" | … (default "A4")
//   orientation {string}  "landscape" | "portrait"  (default "landscape")
//   width_mm    {number}  Optional: exact page width  in mm (overrides format)
//   height_mm   {number}  Optional: exact page height in mm (overrides format)
//
// Returns: application/pdf
//
app.post('/render', async (req, res) => {
  const {
    html,
    paper_size  = 'A4',
    orientation = 'landscape',
    width_mm,
    height_mm,
    scale       = 1,   // 1.0–2.0; use 2 for 300 DPI to render CSS at double resolution
  } = req.body

  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'html field is required' })
  }

  let page = null
  try {
    const browser = await getBrowser()
    page = await browser.newPage()

    // Disable unnecessary network (all assets are inline / base64)
    await page.route('**/*', (route) => {
      const url = route.request().url()
      // Allow data: URIs and same-origin — block everything else
      if (url.startsWith('data:') || url.startsWith('about:')) {
        route.continue()
      } else {
        route.abort()
      }
    })

    await page.setContent(html, { waitUntil: 'load' })

    // Resolve any pending paint / CSS transitions
    await page.waitForTimeout(150)

    // Clamp scale to Playwright's allowed range [0.1, 2.0]
    const pdfScale = Math.min(2.0, Math.max(0.1, Number(scale) || 1))

    const pdfOpts = {
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      scale: pdfScale,
    }

    if (width_mm && height_mm) {
      pdfOpts.width  = `${width_mm}mm`
      pdfOpts.height = `${height_mm}mm`
    } else if (PLAYWRIGHT_FORMATS.has(paper_size)) {
      pdfOpts.format    = paper_size
      pdfOpts.landscape = orientation === 'landscape'
    } else {
      pdfOpts.format    = 'A4'
      pdfOpts.landscape = orientation === 'landscape'
    }

    const pdf = await page.pdf(pdfOpts)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', pdf.length)
    res.send(Buffer.from(pdf))
  } catch (err) {
    console.error('PDF render error:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    if (page) await page.close().catch(() => {})
  }
})

app.listen(PORT, () => console.log(`print-service listening on :${PORT}`))
