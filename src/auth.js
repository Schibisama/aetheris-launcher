'use strict'
// Connexion Microsoft -> Xbox Live -> XSTS -> Minecraft (flux "live" classique, sans compte Azure).
const CLIENT_ID = '00000000402b5328'
const REDIRECT = 'https://login.live.com/oauth20_desktop.srf'
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL'

function authorizeUrl() {
  const q = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPE, prompt: 'select_account',
  })
  return 'https://login.live.com/oauth20_authorize.srf?' + q
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error('Microsoft: ' + (j.error_description || j.error || res.status))
  return j
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    const code = j.XErr
    const map = {
      2148916233: "Ce compte Microsoft n'a pas de profil Xbox. Connecte-toi une fois sur xbox.com pour le créer.",
      2148916235: "Xbox Live n'est pas disponible dans ton pays.",
      2148916238: 'Compte enfant : il doit être ajouté à une famille Microsoft par un adulte.',
    }
    throw new Error(map[code] || 'Authentification refusée (' + res.status + ')' + (code ? ' XErr ' + code : ''))
  }
  return j
}

// Échange un code OU un refresh_token contre une session Minecraft complète.
async function loginFromMicrosoftToken(tok) {
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 't=' + tok.access_token },
    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
  })
  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
  })
  const uhs = xsts.DisplayClaims.xui[0].uhs
  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xsts.Token}`,
  })
  const auth = { Authorization: 'Bearer ' + mc.access_token }
  const ent = await (await fetch('https://api.minecraftservices.com/entitlements/mcstore', { headers: auth })).json()
  const profRes = await fetch('https://api.minecraftservices.com/minecraft/profile', { headers: auth })
  if (profRes.status === 404 || !(ent.items && ent.items.length) && profRes.status !== 200) {
    throw new Error("Ce compte ne possède pas Minecraft Java Edition.")
  }
  const prof = await profRes.json()
  if (!prof.id) throw new Error("Ce compte ne possède pas Minecraft Java Edition.")
  return {
    name: prof.name,
    uuid: prof.id,
    mcToken: mc.access_token,
    mcExpires: Date.now() + (mc.expires_in - 120) * 1000,
    msRefresh: tok.refresh_token,
  }
}

async function loginWithCode(code) {
  const tok = await postForm('https://login.live.com/oauth20_token.srf', {
    client_id: CLIENT_ID, code, grant_type: 'authorization_code', redirect_uri: REDIRECT, scope: SCOPE,
  })
  return loginFromMicrosoftToken(tok)
}

async function refresh(session) {
  if (session.mcToken && session.mcExpires > Date.now()) return session
  const tok = await postForm('https://login.live.com/oauth20_token.srf', {
    client_id: CLIENT_ID, refresh_token: session.msRefresh, grant_type: 'refresh_token',
    redirect_uri: REDIRECT, scope: SCOPE,
  })
  return loginFromMicrosoftToken(tok)
}

module.exports = { authorizeUrl, loginWithCode, refresh, REDIRECT }
