const $ = (id) => document.getElementById(id)
let info
function show(user) {
  $('logged').hidden = !user; $('anon').hidden = !!user
  if (user) $('uname').textContent = user.name
}
function err(t) { $('err').hidden = !t; $('err').textContent = t || '' }
function busy(b) { $('play').disabled = b; $('prog').hidden = !b }
function fmt(n) { return (n / 1048576).toFixed(0) + ' Mo' }

;(async () => {
  info = await window.api.info()
  show(info.user)
  const max = Math.max(4, Math.min(16, Math.floor(info.totalMb / 1024) - 2))
  $('ram').max = max
  $('ram').value = Math.min(max, Math.round(info.ramMb / 1024))
  $('ramv').textContent = $('ram').value
  $('auto').checked = info.autoJoin
})()

$('min').onclick = () => window.api.winControl('min')
$('close').onclick = () => window.api.winControl('close')
$('ram').oninput = (e) => { $('ramv').textContent = e.target.value; window.api.setSettings({ ramMb: e.target.value * 1024 }) }
$('auto').onchange = (e) => window.api.setSettings({ autoJoin: e.target.checked })
$('folder').onclick = () => window.api.openFolder()
$('logout').onclick = async () => { await window.api.logout(); show(null) }
$('login').onclick = async () => {
  err(''); $('login').disabled = true
  try { show(await window.api.login()) } catch (e) { err(String(e.message || e).replace(/^Error invoking remote method '\w+': Error: /, '')) }
  $('login').disabled = false
}
$('play').onclick = async () => { err(''); busy(true); $('fill').style.width = '0'; $('ptext').textContent = 'Préparation…'; await window.api.play() }

window.api.onEvent((d) => {
  if (d.phase === 'log') return
  if (d.phase === 'error') { busy(false); err(d.text); return }
  if (d.phase === 'exit') { busy(false); if (d.code) err('Le jeu s\'est fermé (code ' + d.code + ').'); return }
  if (d.phase === 'running') { $('ptext').textContent = d.text; $('fill').style.width = '100%'; return }
  let t = d.text || ''
  if (d.phase === 'files' && d.total) {
    $('fill').style.width = Math.min(100, d.done / d.total * 100) + '%'
    t = 'Mise à jour : ' + fmt(d.done) + ' / ' + fmt(d.total)
  } else $('fill').style.width = '100%'
  $('ptext').textContent = t
})

function renderMods(list) {
  $('modsCount').textContent = list.length
  const ul = $('modsList'); ul.textContent = ''
  for (const n of list) {
    const li = document.createElement('li')
    const sp = document.createElement('span'); sp.textContent = n; sp.title = n
    const b = document.createElement('button'); b.textContent = '✕'; b.title = 'Retirer'
    b.onclick = async () => renderMods(await window.api.modsRemove(n))
    li.append(sp, b); ul.append(li)
  }
}
window.api.modsList().then(renderMods)
$('modsToggle').onclick = () => { $('modsPanel').hidden = !$('modsPanel').hidden }
$('modsAdd').onclick = async () => renderMods(await window.api.modsAdd())
$('modsFolder').onclick = () => window.api.modsFolder()
