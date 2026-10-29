# Aetheris – version Mac

## Générer l'application (une seule fois, ou à chaque mise à jour du launcher)
1. Mets ce dossier dans un dépôt GitHub (ex. `Schibisama/aetheris-launcher`) : les fichiers `src/`, `build/`, `config.json`, `package.json`, `.github/`.
   (Le dossier `seed/` du launcher Windows est facultatif : sans lui, le Mac télécharge Minecraft/NeoForge en ligne au premier lancement.)
2. Sur GitHub : onglet **Actions → Build Aetheris (Mac) → Run workflow**.
3. Au bout de quelques minutes, télécharge l'artefact **Aetheris-Mac** : `.dmg` / `.zip` pour **arm64** (M1/M2/M3/M4) et **x64** (Mac Intel).

## Première ouverture chez le joueur (app non signée)
- Ouvrir le .dmg, glisser Aetheris dans Applications.
- **Clic droit sur Aetheris → Ouvrir → Ouvrir** (la première fois seulement).
- Si macOS dit « endommagé » : dans Terminal, `xattr -cr /Applications/Aetheris.app` puis relancer.
- Accepter l'accès au micro quand il est demandé (chat vocal).

## Ce qui a changé dans le code
- `game.js` : Java 21 en `.tar.gz` pour Mac (extraction via `tar`), fonction `javaUrlFor` qui choisit selon système + processeur.
- `config.json` : `javaUrls` (win32-x64, darwin-arm64, darwin-x64).
- `main.js` : icône selon le système.
- Données du jeu : `~/Library/Application Support/Aetheris`.

## Non testé
Aucun Mac n'était disponible : le code est vérifié (syntaxe, liens Java) mais pas lancé sur macOS. Premier test = quelqu'un avec un Mac.
