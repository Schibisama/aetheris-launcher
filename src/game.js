'use strict'
const path = require('path')
const fsp = require('fs/promises')
const { spawnSync } = require('child_process')
const AdmZip = require('adm-zip')
const { MinecraftFolder, launch, Version } = require('@xmcl/core')
const { getVersionList, installVersion, installLibraries, installAssets, installNeoForged } = require('@xmcl/installer')
const { exists, downloadTo, walk, sha1File } = require('./util')
const { Agent, interceptors } = require('undici')

// IMPORTANT : l'installateur attend un dispatcher avec gestion des redirections ; sans l'intercepteur, tous les
// téléchargements échouent (fichiers vides, erreur « 'history' »).
function makeDispatcher() {
  return new Agent({ connect: { timeout: 45000 }, headersTimeout: 60000, bodyTimeout: 120000 })
    .compose(interceptors.redirect({ maxRedirections: 8 }))
}

// Si le serveur officiel des textures/sons est injoignable depuis la connexion du joueur,
// on passe par un miroir public (les fichiers sont vérifiés par empreinte sha1, donc sûrs).
async function pickAssetsHost(emit) {
  const official = 'https://resources.download.minecraft.net'
  const mirror = 'https://bmclapi2.bangbang93.com/assets'
  try {
    // Test sur un vrai fichier du jeu (le serveur répond parfois à la racine mais coupe les téléchargements).
    const r = await fetch(official + '/b6/b62ca8ec10d07e6bf5ac8dae0c8c1d2e6a1e3356', { signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error('http ' + r.status)
    await r.arrayBuffer()
    return [official, mirror]
  } catch {
    emit && emit({ phase: 'mirror', text: 'Serveur Mojang injoignable, utilisation d\'un miroir…' })
    return [mirror, official]
  }
}

// Jar du jeu et bibliothèques : officiel d'abord, miroir en secours (ou l'inverse si Mojang est injoignable).
async function pickMojangMirrors(mcVersion) {
  const okOfficial = await reachable('https://piston-data.mojang.com/', 7000)
  const mirrorJar = MIRROR + '/version/' + mcVersion + '/client'
  const mirrorMaven = MIRROR + '/maven/'
  return okOfficial
    ? {}
    : { client: [mirrorJar], mavenHost: [mirrorMaven] }
}

async function retry(fn, emit, label, n = 7, onFail) {
  let last
  for (let i = 1; i <= n; i++) {
    try { return await fn() } catch (e) {
      last = e
      if (onFail) { try { onFail(i) } catch {} }
      emit && emit({ phase: 'retry', text: label + ' : connexion lente, nouvel essai ' + i + '/' + (n - 1) + '…' })
      await new Promise((r) => setTimeout(r, 2000 * i))
    }
  }
  throw last
}


// Fichiers de base de Minecraft livrés avec le launcher (jeu, bibliothèques, index) : évite de dépendre
// des serveurs de Mojang, parfois injoignables. Tout est vérifié par sha1 ensuite.
async function seedMinecraft(mcDir, mcVersion, emit) {
  const seedRoot = path.join(__dirname, '..', 'seed', 'minecraft')
  if (!(await exists(path.join(seedRoot, 'versions', mcVersion, mcVersion + '.json')))) return false
  emit && emit({ phase: 'seed', text: 'Préparation des fichiers de Minecraft…' })
  for (const f of await walk(seedRoot)) {
    const rel = path.relative(seedRoot, f)
    const dst = path.join(mcDir, rel)
    const size = (await fsp.stat(f)).size
    let same = false
    try { same = (await fsp.stat(dst)).size === size } catch {}
    if (same) continue
    await fsp.mkdir(path.dirname(dst), { recursive: true })
    await fsp.copyFile(f, dst)
  }
  await ensureAssetIndex(mcDir, mcVersion)
  return true
}

// L'index des textures est vérifié par sha1 : s'il est absent ou différent (copie d'un autre dossier, fichier réécrit…),
// on remet la copie de référence livrée avec le launcher (seed/index-<sha1>.json).
async function ensureAssetIndex(mcDir, mcVersion) {
  try {
    const vj = JSON.parse(await fsp.readFile(path.join(mcDir, 'versions', mcVersion, mcVersion + '.json'), 'utf8'))
    const ai = vj.assetIndex
    if (!ai) return
    const ref = path.join(__dirname, '..', 'seed', 'index-' + ai.sha1 + '.json')
    if (!(await exists(ref))) return
    for (const name of [ai.id + '.json', ai.sha1 + '.json']) {
      const dst = path.join(mcDir, 'assets', 'indexes', name)
      let ok = false
      try { ok = (await sha1File(dst)) === ai.sha1 } catch {}
      if (!ok) { await fsp.mkdir(path.dirname(dst), { recursive: true }); await fsp.copyFile(ref, dst) }
    }
  } catch {}
}

async function reachable(url, ms = 7000) {
  try { await fetch(url, { signal: AbortSignal.timeout(ms) }); return true } catch { return false }
}

const MIRROR = 'https://bmclapi2.bangbang93.com'

// Au premier échec de téléchargement, on met le miroir en premier pour la suite.
function useMirrorFirst(d) {
  return () => {
    d.assetsHost = [MIRROR + '/assets', 'https://resources.download.minecraft.net']
    d.mavenHost = [MIRROR + '/maven/']
  }
}


// Bibliothèques : indispensables. Textures et sons : si quelques fichiers restent introuvables (connexion bloquée),
// on lance quand même le jeu (au pire, quelques sons manquent) au lieu de tout bloquer.
async function ensureDependencies(resolved, d, emit, tries) {
  await retry(() => installLibraries(resolved, d), emit, 'Bibliothèques', 7, useMirrorFirst(d))
  try {
    await retry(() => installAssets(resolved, d), emit, 'Textures et sons', tries, useMirrorFirst(d))
  } catch (e) {
    emit && emit({ phase: 'warn', text: 'Certains sons/textures n\'ont pas pu être téléchargés : le jeu se lance quand même.' })
    try { require('fs').appendFileSync(path.join(path.dirname(resolved.minecraftDirectory), 'assets-manquants.log'), new Date().toISOString() + ' ' + String(e && e.message || e).slice(0, 400) + '\n') } catch {}
  }
}

const isWin = process.platform === 'win32'

async function findJava(runtimeDir) {
  const exe = isWin ? 'javaw.exe' : 'java'
  for (const f of await walk(runtimeDir)) {
    if (path.basename(f) === exe && path.basename(path.dirname(f)) === 'bin') return f
  }
  return null
}

async function ensureJava(runtimeDir, url, emit) {
  let j = await findJava(runtimeDir)
  if (j) return j
  emit({ phase: 'java', text: 'Téléchargement de Java 21…' })
  const isTar = /\.tar\.gz(\?.*)?$/.test(url)
  const archive = path.join(runtimeDir, isTar ? 'java.tar.gz' : 'java.zip')
  await downloadTo(url, archive)
  emit({ phase: 'java', text: 'Installation de Java 21…' })
  if (isTar) {
    // macOS / Linux : archive .tar.gz (la commande "tar" existe sur tous les Mac).
    const r = spawnSync('tar', ['-xzf', archive, '-C', runtimeDir])
    if (r.status !== 0) throw new Error('Extraction de Java impossible : ' + String(r.stderr || r.error || ''))
  } else {
    new AdmZip(archive).extractAllTo(runtimeDir, true)
  }
  await fsp.rm(archive, { force: true })
  j = await findJava(runtimeDir)
  if (!j) throw new Error('Java introuvable après installation.')
  if (!isWin) await fsp.chmod(j, 0o755).catch(() => {})
  return j
}

// Le programme d'installation de NeoForge a besoin de "java" (pas javaw) en ligne de commande.
function consoleJava(javaPath) {
  return path.basename(javaPath) === 'javaw.exe' ? path.join(path.dirname(javaPath), 'java.exe') : javaPath
}

async function ensureGame({ root, mcVersion, neoVersion, javaUrl, emit, dispatcher, extra }) {
  const d = {
    dispatcher: dispatcher || makeDispatcher(),
    assetsHost: await pickAssetsHost(emit),
    ...(await pickMojangMirrors(mcVersion)),
    assetsDownloadConcurrency: 4, librariesDownloadConcurrency: 4,
    rangePolicy: { computeRanges: (len) => [{ start: 0, end: len - 1 }] }, // une seule connexion par fichier
    ...(extra || {}),
  }
  const mcDir = path.join(root, 'minecraft')
  await fsp.mkdir(mcDir, { recursive: true })
  const javaPath = await ensureJava(path.join(root, 'runtime'), javaUrl, emit)
  const folder = new MinecraftFolder(mcDir)
  const stateFile = path.join(root, 'install-state.json')
  let state = {}
  try { state = JSON.parse(await fsp.readFile(stateFile, 'utf8')) } catch {}
  const key = mcVersion + '/' + neoVersion
  if (state.key === key && state.versionId && (await exists(folder.getVersionJson(state.versionId)))) {
    // Vérifie / répare les librairies (rapide si tout est là).
    emit({ phase: 'verify', text: 'Vérification du jeu…' })
    await seedMinecraft(mcDir, mcVersion, emit).catch(() => {})
    const resolved = await Version.parse(folder, state.versionId)
    await ensureDependencies(resolved, d, emit, 2)
    return { mcDir, javaPath, versionId: state.versionId }
  }
  emit({ phase: 'minecraft', text: 'Installation de Minecraft ' + mcVersion + '…' })
  const seeded = await seedMinecraft(mcDir, mcVersion, emit)
  let meta
  if (seeded) {
    // Le fichier de version est déjà là : on évite d'interroger les serveurs de Mojang.
    const jsonPath = folder.getVersionJson(mcVersion)
    const sha1 = require('crypto').createHash('sha1').update(await fsp.readFile(jsonPath)).digest('hex')
    meta = { id: mcVersion, url: 'https://piston-meta.mojang.com/v1/packages/' + sha1 + '/' + mcVersion + '.json' }
  } else {
    const list = await retry(() => getVersionList(d), emit, 'Liste des versions')
    meta = list.versions.find((v) => v.id === mcVersion)
    if (!meta) throw new Error('Version Minecraft introuvable: ' + mcVersion)
  }
  await retry(() => installVersion(meta, folder, d), emit, 'Minecraft')
  emit({ phase: 'neoforge', text: 'Installation de NeoForge ' + neoVersion + '… (peut durer quelques minutes)' })
  // NeoForge déjà préparé avec le launcher (évite le téléchargement de l'installateur) ; sinon installation en ligne.
  const seededId = 'neoforge-' + neoVersion
  const versionId = (await exists(folder.getVersionJson(seededId)))
    ? seededId
    : await retry(() => installNeoForged('neoforge', neoVersion, folder, { java: consoleJava(javaPath), ...d }), emit, 'NeoForge')
  const resolved = await Version.parse(folder, versionId)
  emit({ phase: 'libs', text: 'Téléchargement des bibliothèques…' })
  await ensureDependencies(resolved, d, emit, 4)
  await fsp.writeFile(stateFile, JSON.stringify({ key, versionId }))
  return { mcDir, javaPath, versionId }
}

async function start({ mcDir, javaPath, versionId, session, ramMb, server, onLog, onExit }) {
  const proc = await launch({
    gamePath: mcDir,
    resourcePath: mcDir,
    javaPath,
    version: versionId,
    gameProfile: { name: session.name, id: session.uuid },
    accessToken: session.mcToken,
    userType: 'msa',
    launcherName: 'Aetheris',
    launcherBrand: 'Aetheris',
    minMemory: Math.min(2048, ramMb),
    maxMemory: ramMb,
    extraJVMArgs: ['-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC'],
    ...(server ? { server: { ip: server.split(':')[0], port: server.includes(':') ? Number(server.split(':')[1]) : 25565 } } : {}),
  })
  proc.stdout && proc.stdout.on('data', (d) => onLog && onLog(String(d)))
  proc.stderr && proc.stderr.on('data', (d) => onLog && onLog(String(d)))
  proc.on('exit', (code) => onExit && onExit(code))
  return proc
}

// URL de Java 21 selon le système et le processeur (config.javaUrls, sinon l'ancienne clé Windows).
function javaUrlFor(config) {
  const key = process.platform + '-' + process.arch // ex. win32-x64, darwin-arm64, darwin-x64
  return (config.javaUrls && config.javaUrls[key]) || config.javaFallbackUrl
}

module.exports = { javaUrlFor, ensureGame, start, _seedMinecraft: seedMinecraft, _ensureDependencies: ensureDependencies, _makeDispatcher: makeDispatcher }
