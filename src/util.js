'use strict'
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const { Transform } = require('stream')

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1')
    const s = fs.createReadStream(file)
    s.on('error', reject)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

async function exists(p) {
  try { await fsp.access(p); return true } catch { return false }
}

// Télécharge url -> dest (via un fichier .part), vérifie taille + sha1, réessaie en cas d'échec.
async function downloadTo(url, dest, opts = {}) {
  const { sha1, onBytes, tries = 6 } = opts
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  let lastErr
  for (let i = 0; i < tries; i++) {
    const part = dest + '.part'
    let counted = 0
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'Accept-Encoding': 'identity' } })
      if (!res.ok) throw new Error('HTTP ' + res.status + ' pour ' + url)
      const expected = Number(res.headers.get('content-length') || 0)
      const counter = new Transform({
        transform(chunk, _enc, cb) { counted += chunk.length; onBytes && onBytes(chunk.length); cb(null, chunk) },
      })
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part))
      if (expected && counted !== expected) throw new Error('Téléchargement incomplet (' + counted + '/' + expected + ')')
      if (sha1) {
        const got = await sha1File(part)
        if (got !== sha1) throw new Error('Empreinte incorrecte pour ' + path.basename(dest))
      }
      await fsp.rename(part, dest)
      return
    } catch (e) {
      lastErr = e
      if (onBytes && counted) onBytes(-counted)
      try { await fsp.rm(part, { force: true }) } catch {}
      await new Promise((r) => setTimeout(r, 1000 * (i + 1) * (i + 1)))
    }
  }
  throw lastErr
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' pour ' + url)
  return res.json()
}

// Parallélise des tâches avec une limite.
async function pool(items, limit, worker) {
  let i = 0
  const runners = []
  for (let n = 0; n < Math.min(limit, items.length); n++) {
    runners.push((async () => {
      while (true) {
        const idx = i++
        if (idx >= items.length) return
        await worker(items[idx], idx)
      }
    })())
  }
  await Promise.all(runners)
}

async function walk(dir) {
  const out = []
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (e.isFile()) out.push(p)
  }
  return out
}

module.exports = { sha1File, exists, downloadTo, fetchJson, pool, walk }
