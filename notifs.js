// ─────────────────────────────────────────────────────────────────────────────
// Serveur de notifications PROGRAMMÉES de Daba (rappels / réengagement).
// Tourne via un cron GitHub Actions (gratuit). Il LIT Firestore + Open-Meteo +
// le calendrier `evenements`, puis envoie via l'API push d'Expo.
//
// Anti-doublon : marqueurs `notifs.*` écrits sur chaque fiche utilisateur.
// DRY_RUN=1  → n'envoie RIEN, affiche juste ce qui partirait (test sûr).
//
// Clé service : variable d'env FIREBASE_SERVICE_ACCOUNT (secret GitHub, JSON).
// En local, repli automatique sur la clé admin du projet (pour tester en DRY).
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function chargerCle() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const dir = '/Users/bilelsayy/Documents/DabaApp'; // repli local (DRY)
  const f = fs.readdirSync(dir).find((x) => /firebase-adminsdk.*\.json$/.test(x));
  return require(path.join(dir, f));
}
initializeApp({ credential: cert(chargerCle()) });
const db = getFirestore();

const DRY = !!process.env.DRY_RUN;
const NOW = Date.now();
const JOUR = 86400000;
// Comptes test/démo : jamais de notif marketing.
// bilelosa@gmail.com RETIRÉ (compte réel du fondateur, doit recevoir le marketing pour voir le rendu).
const EXCLUS = ['coursier@daba.ma', 'test@daba.ma', 'demo@daba.ma', 'demo-coursier@daba.ma'];
const MARRAKECH = { lat: 31.63, lng: -7.98 };

const heureMaroc = () =>
  Number(new Date().toLocaleString('en-US', { timeZone: 'Africa/Casablanca', hour: '2-digit', hour12: false }));
const jourMaroc = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' });
const prenomDe = (u) => (u.prenom || (u.email || '').split('@')[0] || '').trim();

const envois = []; // { email, to, titre, corps }
const marqueurs = {}; // uid -> { notifs à fusionner }

function programmer(u, titre, corps, marque) {
  envois.push({ email: u.email, to: u.expoPushToken, titre, corps });
  if (marque) marqueurs[u.id] = { ...(marqueurs[u.id] || {}), ...marque };
}

async function envoyerTout() {
  const messages = envois.map((e) => ({
    to: e.to,
    title: e.titre,
    body: e.corps,
    sound: 'default',
    priority: 'high',
  }));
  if (DRY) {
    console.log(`\n[DRY_RUN] ${messages.length} notif(s) qui PARTIRAIENT :`);
    envois.forEach((e) => console.log(`  → ${e.email} | ${e.titre} — ${e.corps}`));
    return;
  }
  for (let i = 0; i < messages.length; i += 100) {
    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages.slice(i, i + 100)),
      });
    } catch (e) {
      console.error('Push err:', e.message);
    }
  }
  // Marqueurs anti-doublon (écriture Firestore)
  for (const [uid, m] of Object.entries(marqueurs)) {
    await db.collection('utilisateurs').doc(uid).set({ notifs: m }, { merge: true }).catch(() => {});
  }
  console.log(`Envoyé : ${messages.length} notif(s).`);
}

// Pluie (≥1 mm) ou grosse chaleur (≥38 °C) aujourd'hui à Marrakech ? (Open-Meteo, gratuit)
async function meteoDuJour() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${MARRAKECH.lat}&longitude=${MARRAKECH.lng}&hourly=precipitation,temperature_2m&forecast_days=1&timezone=Africa%2FCasablanca`;
    const j = await (await fetch(url)).json();
    return {
      pluie: (j.hourly?.precipitation || []).some((p) => p >= 1),
      chaud: (j.hourly?.temperature_2m || []).some((t) => t >= 38),
    };
  } catch {
    return { pluie: false, chaud: false };
  }
}

(async () => {
  const h = heureMaroc();
  const jour = jourMaroc();

  // Clients avec token (hors comptes test/démo)
  const usnap = await db.collection('utilisateurs').where('role', '==', 'client').get();
  const clients = usnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((u) => u.expoPushToken && !EXCLUS.includes((u.email || '').toLowerCase()));

  // Commandes groupées par client
  const dsnap = await db.collection('demandes').get();
  const parClient = {};
  dsnap.docs.forEach((d) => {
    const x = d.data();
    if (x.clientId) (parClient[x.clientId] ||= []).push(x);
  });

  const meteo = h >= 11 && h <= 18 ? await meteoDuJour() : { pluie: false, chaud: false };

  for (const u of clients) {
    const cmds = parClient[u.id] || [];
    const notifs = u.notifs || {};
    const inscritMs = u.creeLe?.toMillis?.() ?? 0;
    const ageMs = NOW - inscritMs;

    // 1) BIENVENUE — inscrit il y a 1-3 j, aucune commande, pas déjà accueilli
    if (h >= 10 && h <= 20 && !notifs.welcome && cmds.length === 0 && ageMs > JOUR && ageMs < 3 * JOUR) {
      programmer(u, 'Bienvenue sur Daba 👋', `${prenomDe(u)}, ta première demande prend 30 s — on te livre n'importe quoi, même là où les autres ne vont pas.`, { welcome: true });
      continue;
    }

    // 2) RE-COMMANDER — dernière commande > 4 j, créneau repas, pas relancé depuis 7 j
    const terminees = cmds.filter((c) => c.statut === 'terminée');
    const repas = (h >= 12 && h <= 13) || (h >= 19 && h <= 20);
    if (repas && terminees.length) {
      const derniere = terminees
        .map((c) => ({ t: c.termineeLe?.toMillis?.() || c.creeLe?.toMillis?.() || 0, nom: c.titre || 'ton resto' }))
        .sort((a, b) => b.t - a.t)[0];
      if (NOW - derniere.t > 4 * JOUR && NOW - (notifs.recommande || 0) > 7 * JOUR) {
        programmer(u, 'Envie de te régaler ? 🍔', `Re-commander chez ${derniere.nom} ? En 2 taps sur Daba.`, { recommande: NOW });
        continue;
      }
    }

    // 3) MÉTÉO — pluie / chaleur, 1 fois par jour max
    if ((meteo.pluie || meteo.chaud) && notifs.meteo !== jour) {
      const [titre, corps] = meteo.pluie
        ? ['Il pleut ☔', 'Reste au chaud — fais-toi livrer ce que tu veux avec Daba.']
        : ['Trop chaud pour sortir ? 🥤', "On s'en occupe : commande sur Daba, on te livre."];
      programmer(u, titre, corps, { meteo: jour });
      continue;
    }

    // 4) RÉACTIVATION — aucune activité depuis 14 j, pas relancé depuis 30 j (le soir)
    const derniereActivite = Math.max(inscritMs, ...cmds.map((c) => c.creeLe?.toMillis?.() || 0));
    if (h >= 17 && h <= 19 && NOW - derniereActivite > 14 * JOUR && NOW - (notifs.reactive || 0) > 30 * JOUR) {
      programmer(u, 'Ça fait un moment ! 👀', `${prenomDe(u)}, ta prochaine livraison t'attend. Un petit creux ?`, { reactive: NOW });
      continue;
    }
  }

  // 5) MATCHS / ÉVÈNEMENTS — calendrier curé, ~2 h avant, envoyé une seule fois
  const evs = await db.collection('evenements').where('envoye', '==', false).get().catch(() => ({ docs: [] }));
  for (const ev of evs.docs) {
    const debut = ev.data().debut?.toMillis?.();
    if (!debut) continue;
    const dans = debut - NOW;
    if (dans > 0 && dans < 2.5 * 3600 * 1000) {
      for (const u of clients) {
        envois.push({
          email: u.email,
          to: u.expoPushToken,
          titre: ev.data().titre || '⚽ Ce soir',
          corps: ev.data().message || "Commande tes snacks avant le coup d'envoi sur Daba.",
        });
      }
      if (DRY) console.log(`[DRY_RUN] Évènement « ${ev.data().titre} » → ${clients.length} clients`);
      else await ev.ref.update({ envoye: true }).catch(() => {});
    }
  }

  await envoyerTout();
  process.exit(0);
})().catch((e) => {
  console.error('Erreur :', e.message);
  process.exit(1);
});
