'use strict'
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const config = require('../config.json')
const auth = require('./auth')
const { syncFiles } = require('./sync')
const game = require('./game')

const root = path.join(app.getPath('appData'), config.launcherName)
const storeFile = path.join(root, 'launcher.json')
let win = null
let busy = false

function load() { try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')) } catch { return {} } }
function save(d) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(storeFile, JSON.stringify(d, null, 1)) }
function describe(e, depth = 0) {
  if (!e || depth > 3) return ''
  const parts = []
  if (e.message) parts.push(e.message)
  if (e.code) parts.push('[' + e.code + ']')
  if (e.url) parts.push(String(e.url))
  if (e.source) parts.push(String(e.source))
  if (Array.isArray(e.errors)) for (const x of e.errors.slice(0, 3)) parts.push(describe(x, depth + 1))
  if (e.error) parts.push(describe(e.error, depth + 1))
  if (e.cause) parts.push(describe(e.cause, depth + 1))
  return parts.filter(Boolean).join(' | ')
}
function logLine(t) {
  try { fs.mkdirSync(root, { recursive: true }); fs.appendFileSync(path.join(root, 'launcher.log'), '[' + new Date().toISOString() + '] ' + t + '\n') } catch {}
}
function emit(d) {
  if (d && d.text && d.phase !== 'log') logLine(d.phase + ': ' + d.text)
  if (win && !win.isDestroyed()) win.webContents.send('evt', d) }

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 600, resizable: false, frame: false, backgroundColor: '#0b1020',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'logo.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  win.setMenu(null)
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

function microsoftLogin() {
  return new Promise((resolve, reject) => {
    const part = 'login-' + Date.now() // session temporaire, rien n'est gardé dans le navigateur
    const w = new BrowserWindow({
      width: 520, height: 680, parent: win, modal: true, autoHideMenuBar: true, title: 'Connexion Microsoft',
      webPreferences: { partition: part, contextIsolation: true },
    })
    let finished = false
    const check = (url) => {
      if (finished || !url.startsWith(auth.REDIRECT)) return false
      finished = true
      const u = new URL(url)
      const code = u.searchParams.get('code')
      w.destroy()
      code ? resolve(code) : reject(new Error(u.searchParams.get('error_description') || 'Connexion annulée'))
      return true
    }
    w.webContents.on('will-redirect', (e, url) => { if (check(url)) e.preventDefault() })
    w.webContents.on('will-navigate', (e, url) => { if (check(url)) e.preventDefault() })
    w.on('closed', () => { if (!finished) { finished = true; reject(new Error('Connexion annulée')) } })
    w.loadURL(auth.authorizeUrl())
  })
}

ipcMain.handle('info', () => {
  const s = load()
  return {
    name: config.launcherName,
    user: s.session ? { name: s.session.name, uuid: s.session.uuid } : null,
    ramMb: s.ramMb || config.defaultRamMb,
    totalMb: Math.floor(os.totalmem() / 1048576),
    autoJoin: s.autoJoin !== false,
    version: app.getVersion(),
  }
})

ipcMain.handle('login', async () => {
  const code = await microsoftLogin()
  const sess = await auth.loginWithCode(code)
  const s = load(); s.session = sess; save(s)
  return { name: sess.name, uuid: sess.uuid }
})

ipcMain.handle('logout', () => { const s = load(); delete s.session; save(s); return true })
ipcMain.handle('settings', (_e, v) => { const s = load(); Object.assign(s, v); save(s); return true })
const userModsDir = path.join(root, 'mods-perso')
function listUserMods() {
  try { return fs.readdirSync(userModsDir).filter((f) => f.toLowerCase().endsWith('.jar')).sort() } catch { return [] }
}
function copyUserMods(mcDir) {
  const dest = path.join(mcDir, 'mods')
  fs.mkdirSync(dest, { recursive: true })
  let n = 0
  for (const f of listUserMods()) {
    const target = path.join(dest, f)
    if (fs.existsSync(target)) continue // même nom qu'un mod du serveur : celui du serveur gagne
    fs.copyFileSync(path.join(userModsDir, f), target); n++
  }
  return n
}
ipcMain.handle('mods-list', () => listUserMods())
ipcMain.handle('mods-add', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Ajouter des mods (client uniquement)', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Mods Minecraft (.jar)', extensions: ['jar'] }],
  })
  if (r.canceled) return listUserMods()
  fs.mkdirSync(userModsDir, { recursive: true })
  for (const f of r.filePaths) {
    if (!f.toLowerCase().endsWith('.jar')) continue
    fs.copyFileSync(f, path.join(userModsDir, path.basename(f)))
  }
  return listUserMods()
})
ipcMain.handle('mods-remove', (_e, name) => {
  const f = path.join(userModsDir, path.basename(String(name)))
  try { fs.rmSync(f, { force: true }) } catch {}
  try { fs.rmSync(path.join(mcDirOf(), 'mods', path.basename(f)), { force: true }) } catch {}
  return listUserMods()
})
ipcMain.handle('mods-folder', () => { fs.mkdirSync(userModsDir, { recursive: true }); return shell.openPath(userModsDir) })
function mcDirOf() { return path.join(root, 'minecraft') }
ipcMain.handle('open-folder', () => shell.openPath(path.join(root, 'minecraft')))
ipcMain.on('win', (_e, a) => { if (!win) return; a === 'min' ? win.minimize() : a === 'close' ? win.close() : 0 })

ipcMain.handle('play', async () => {
  if (busy) return false
  busy = true
  try {
    let s = load()
    if (!s.session) throw new Error('Connecte-toi d\'abord.')
    emit({ phase: 'auth', text: 'Connexion au compte…' })
    s.session = await auth.refresh(s.session); save(s)

    emit({ phase: 'manifest', text: 'Recherche de mises à jour…' })
    const mcDir = path.join(root, 'minecraft')
    const r = await syncFiles(config.manifestUrl, mcDir, (p) => emit({ ...p, text: 'Mise à jour des fichiers…' }))
    const m = r.manifest
    const nPerso = copyUserMods(mcDir)
    if (nPerso) logLine('mods perso copiés: ' + nPerso)
    const g = await game.ensureGame({
      root, mcVersion: m.minecraft, neoVersion: m.neoforge, javaUrl: game.javaUrlFor(config), emit,
    })
    emit({ phase: 'launch', text: 'Lancement du jeu…' })
    const server = s.autoJoin === false ? '' : (m.server || config.serverAddress)
    await game.start({
      ...g, session: s.session, ramMb: s.ramMb || config.defaultRamMb, server,
      onLog: (t) => emit({ phase: 'log', text: t }),
      onExit: (code) => { busy = false; emit({ phase: 'exit', code }); if (win) win.show() },
    })
    emit({ phase: 'running', text: 'Le jeu est lancé. Bon jeu !' })
    setTimeout(() => win && !win.isDestroyed() && win.minimize(), 4000)
    return true
  } catch (e) {
    busy = false
    const msg = describe(e) || String(e)
    logLine('ERREUR: ' + msg + '\n' + (e && e.stack || ''))
    emit({ phase: 'error', text: msg.slice(0, 400) + '  (détails : ' + path.join(root, 'launcher.log') + ')' })
    return false
  }
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
