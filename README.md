# Notifications programmées Daba

Petit serveur **gratuit** (cron GitHub Actions) qui envoie les notifications de
rappel / réengagement. Il n'a **pas besoin du code de l'app** — c'est un repo à part.

## Ce qu'il envoie (starter pack)

| Type | Quand | Fréquence |
|---|---|---|
| **Bienvenue** | inscrit il y a 1-3 j, sans commande | 1 fois |
| **Re-commander** | dernière commande > 4 j, aux heures de repas (12-13h / 19-20h Maroc) | max 1×/semaine |
| **Météo** ☔🥤 | pluie ou grosse chaleur à Marrakech (Open-Meteo, auto) | max 1×/jour |
| **Réactivation** | aucune activité depuis 14 j (le soir) | max 1×/30 j |
| **Matchs / évènements** | ~2h avant un évènement du calendrier `evenements` | 1 fois/évènement |

Les **comptes test/démo** sont exclus. Anti-doublon via des marqueurs `notifs.*`
écrits sur chaque fiche utilisateur.

## Installation (une seule fois)

### 1. Créer la clé service Firebase (accès **Firestore uniquement**)
Console Google Cloud → projet **dabaapp-b2f20** → *IAM & Admin → Service Accounts* →
**Create service account** (ex. `notifs-daba`) → rôle **« Cloud Datastore User »**
(lecture + écriture Firestore, **rien d'autre** : ne touche ni à l'Auth, ni à la
facturation, ni au reste). Puis *Keys → Add key → JSON* → télécharge le fichier.

> ⚠️ Il faut lecture **ET écriture** (pas seulement lecture) : le serveur écrit de
> petits marqueurs « déjà envoyé » pour ne pas te spammer. Mais le rôle reste
> limité à Firestore → il ne peut rien casser d'autre.

### 2. Mettre ce dossier sur un repo GitHub **privé**
Copie-le **hors** de DabaApp (pour ne pas créer un repo imbriqué), puis :
```bash
cp -R serveur-notifs ~/daba-notifs
cd ~/daba-notifs
git init && git add -A && git commit -m "Notifs Daba"
# crée un repo PRIVÉ sur github.com, puis :
git remote add origin git@github.com:<toi>/daba-notifs.git
git push -u origin main
```

### 3. Ajouter la clé en secret GitHub
Repo GitHub → *Settings → Secrets and variables → Actions → New repository secret* :
- **Nom** : `FIREBASE_SERVICE_ACCOUNT`
- **Valeur** : colle **tout le contenu** du fichier JSON de l'étape 1.

C'est fini. Le cron tourne **toutes les heures** ; tu peux aussi le lancer à la
main (onglet *Actions → Notifications Daba → Run workflow*).

## Ajouter un match / évènement (calendrier curé)
Dans la **console Firebase → Firestore**, collection **`evenements`**, nouveau document :
| Champ | Type | Exemple |
|---|---|---|
| `titre` | string | `⚽ Maroc – Algérie ce soir` |
| `message` | string | `Commande tes snacks avant le coup d'envoi sur Daba 🍿` |
| `debut` | timestamp | l'heure du **coup d'envoi** |
| `envoye` | boolean | `false` |

Le serveur envoie ~2h avant `debut`, puis passe `envoye` à `true` tout seul.

## Tester sans rien envoyer (DRY RUN)
```bash
DRY_RUN=1 node notifs.js   # affiche qui serait notifié, n'envoie rien
```
