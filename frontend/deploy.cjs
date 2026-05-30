#!/usr/bin/env node
/**
 * Post-build deploy script.
 *
 * After `vite build` outputs to ../staticfiles/ this script:
 *   1. Copies assets/* → ../static/frontend/assets/  (so collectstatic picks them up)
 *   2. Copies index.html → ../static/frontend/index.html  (Django spa_index serves this)
 *   3. Copies index.html → ../templates/index.html  (fallback dev template)
 *   4. Copies assets/* → ../data/staticfiles/assets/  (direct nginx serve path, if writable)
 */

const fs   = require('fs')
const path = require('path')

const root      = path.join(__dirname, '..')
const buildDir  = path.join(root, 'staticfiles', 'assets')
const targets   = [
  path.join(root, 'static', 'frontend', 'assets'),
  path.join(root, 'data', 'staticfiles', 'assets'),   // direct nginx path
]
const indexSrc   = path.join(root, 'staticfiles', 'index.html')
const indexDests = [
  path.join(root, 'static', 'frontend', 'index.html'),
  path.join(root, 'templates', 'index.html'),
  path.join(root, 'data', 'staticfiles', 'frontend', 'index.html'),
]

let copied = 0

for (const target of targets) {
  try {
    fs.mkdirSync(target, { recursive: true })
    for (const f of fs.readdirSync(buildDir)) {
      const src = path.join(buildDir, f)
      const dst = path.join(target, f)
      fs.copyFileSync(src, dst)
      copied++
    }
  } catch (e) {
    // data/staticfiles may be owned by another user in Docker — skip silently
  }
}

for (const dest of indexDests) {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(indexSrc, dest)
  } catch (e) {
    // skip if not writable
  }
}

console.log(`deploy.cjs: synced ${copied} asset files`)
