'use strict'
// Synchronise le dossier de jeu avec le manifest publié sur GitHub.
// manifest.json: { version, minecraft, neoforge, files:[{path,sha1,size,url?}], optional:[...] }
// Les fichiers sous "managed" (mods/, kubejs/, config/...) sont gérés : tout ce qui n'est pas dans le
// manifest est supprimé, sauf les dossiers "keep" (saves, screenshots, options.txt, etc.).
const path = require('path')
const fsp = require('fs/promises')
const { sha1File, exists, downloadTo, fetchJson, pool, walk } = require('./util')

function safeJoin(root, rel) {
  const p = path.resolve(root, rel)
  if (!p.startsWith(path.resolve(root) + path.sep)) throw new Error('Chemin invalide dans le manifest: ' + rel)
  return p
}

async function syncFiles(manifestUrl, gameDir, onProgress) {
  const manifest = await fetchJson(manifestUrl)
  const base = manifestUrl.replace(/manifest\.json(\?.*)?$/, '')
  const managed = manifest.managed || ['mods', 'kubejs', 'shaderpacks', 'resourcepacks']
  const files = manifest.files || []
  const wanted = new Map(files.map((f) => [path.resolve(gameDir, f.path), f]))

  // 1) Supprimer ce qui est géré mais plus listé.
  let removed = 0
  for (const dir of managed) {
    for (const f of await walk(path.join(gameDir, dir))) {
      if (!wanted.has(path.resolve(f)) && !f.endsWith('.part')) {
        await fsp.rm(f, { force: true }); removed++
      }
    }
  }

  // 2) Déterminer ce qu'il faut télécharger.
  const todo = []
  for (const f of files) {
    const dest = safeJoin(gameDir, f.path)
    // Fichiers "config" marqués once: ne pas écraser si déjà présents (réglages joueur).
    if (f.once && (await exists(dest))) continue
    if ((await exists(dest)) && (await sha1File(dest)) === f.sha1) continue
    todo.push({ f, dest })
  }
  const total = todo.reduce((a, t) => a + (t.f.size || 0), 0)
  let done = 0
  onProgress && onProgress({ phase: 'files', done: 0, total, count: todo.length, removed })
  await pool(todo, 3, async ({ f, dest }) => {
    const url = f.url || base + f.path.split('/').map(encodeURIComponent).join('/')
    await downloadTo(url, dest, {
      sha1: f.sha1,
      onBytes: (n) => { done += n; onProgress && onProgress({ phase: 'files', done, total, count: todo.length, removed, file: f.path }) },
    })
  })
  return { manifest, downloaded: todo.length, removed }
}

module.exports = { syncFiles }
