// ─────────────────────────────────────────────────────────────────────────────
// Serveur de notifications PROGRAMMÉES de Daba (rappels / réengagement).
// Tourne via un cron GitHub Actions (gratuit). Il LIT Firestore + Open-Meteo +
// le calendrier `evenements`, puis envoie via l'API push d'Expo.
//
// Garde-fous :
//   • Anti-doublon par type : marqueurs `notifs.*` (welcome, meteo=jour, ...).
//   • Anti-RÉPÉTITION : `notifs.dernier` = signature de la dernière notif envoyée.
//     On ne renvoie jamais 2 fois DE SUITE la même notification.
//   • Maroc uniquement : on n'envoie qu'aux clients localisés au Maroc
//     (position GPS enregistrée par l'app, ou coord de leur dernière demande).
//
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

// Bounding box du Maroc (mêmes bornes que l'app, constants/geo.ts → estAuMaroc).
const estAuMaroc = (c) => !!c && c.lat >= 20.5 && c.lat <= 36.2 && c.lng >= -17.5 && c.lng <= -0.5;

const heureMaroc = () =>
  Number(new Date().toLocaleString('en-US', { timeZone: 'Africa/Casablanca', hour: '2-digit', hour12: false }));
const jourMaroc = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' });
const prenomDe = (u) => (u.prenom || (u.email || '').split('@')[0] || '').trim();

const envois = []; // { email, to, titre, corps }
const marqueurs = {}; // uid -> { notifs à fusionner }

// Programme une notif. `sig` = signature de son contenu : si c'est EXACTEMENT la
// même que la dernière notif reçue par l'utilisateur → on annule (pas 2× de suite).
function programmer(u, titre, corps, marque, sig) {
  if (sig && (u.notifs || {}).dernier === sig) return false;
  envois.push({ email: u.email, to: u.expoPushToken, titre, corps });
  marqueurs[u.id] = { ...(marqueurs[u.id] || {}), ...(marque || {}), ...(sig ? { dernier: sig } : {}) };
  return true;
}

async function envoyerTout() {
  const messages = envois.map((e) => ({
    to: e.to,
    title: e.titre,
    body: e.corps,
    sound: 'default',
    priority: 'high',
    // Relance de COMMANDE → aussi voyante que le push d'origine de l'app :
    // canal Android importance max + vibreur, « Temps fort » iOS, et le tap
    // ouvre directement la commande (data.demandeId).
    ...(e.commande && {
      channelId: 'commandes',
      vibrate: [0, 400, 200, 400, 200, 400],
      sticky: true,
      interruptionLevel: 'time-sensitive', // ⚠️ avec tiret — sinon Expo rejette TOUT
      data: { demandeId: e.commande },
    }),
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
  // Marqueurs anti-doublon + `dernier` (écriture Firestore)
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


// ─────────────────────────────────────────────────────────────────────────────
// RAPPELS DE VALIDATION (transactionnels, indépendants du marketing).
// Ils partent même si l'app est fermée — c'est tout l'intérêt : l'app ne détecte
// l'éloignement que lorsqu'elle est ouverte.
//   • Coursier : les deux se sont rencontrés, il est reparti, mais la course est
//     toujours « en cours » → il a oublié de valider.
//   • Client : le coursier a validé (« livrée »), le client ne confirme pas.
// Anti-doublon par marqueurs sur la DEMANDE (pas sur l'utilisateur).
// ─────────────────────────────────────────────────────────────────────────────
const MIN = 60000;
const RAPPEL_COURSIER_MS = 15 * MIN; // 15 min après la rencontre
const RAPPEL_CLIENT_1_MS = 20 * MIN; // 20 min après « livrée »
const RAPPEL_CLIENT_2_MS = 120 * MIN; // puis 2 h
// Au-delà, on ne relance plus : inutile de réveiller une commande d'il y a
// plusieurs jours restée ouverte (le rappel n'aurait plus aucun sens).
const RAPPEL_AGE_MAX_MS = 24 * 60 * MIN;

async function jetonDe(uid) {
  if (!uid) return null;
  const d = await db.collection('utilisateurs').doc(uid).get().catch(() => null);
  const t = d && d.exists ? d.data().expoPushToken : null;
  return t && String(t).startsWith('ExponentPushToken') ? t : null;
}

async function rappelsValidation() {
  const snap = await db
    .collection('demandes')
    .where('statut', 'in', ['en cours', 'livrée'])
    .get()
    .catch(() => ({ docs: [] }));

  for (const doc of snap.docs) {
    const d = doc.data();
    const ms = (k) => (d[k] && d[k].toMillis ? d[k].toMillis() : 0);

    // ── Coursier : il a oublié de valider ──
    if (d.statut === 'en cours' && ms('rencontreLe') && !d.rappelCoursier) {
      const age = NOW - ms('rencontreLe');
      if (age > RAPPEL_COURSIER_MS && age < RAPPEL_AGE_MAX_MS) {
        const to = await jetonDe(d.coursierId);
        if (to) {
          envois.push({
            email: 'coursier:' + d.coursierId,
            to,
            titre: '📦 Tu as livré le client ?',
            corps: `Valide la livraison de « ${d.titre} » dans Daba pour clôturer la course.`,
          });
        }
        if (!DRY) await doc.ref.update({ rappelCoursier: true }).catch(() => {});
      }
    }

    // ── Client : le coursier a validé, lui n'a pas confirmé ──
    if (d.statut === 'livrée' && ms('livreeLe')) {
      const age = NOW - ms('livreeLe');
      const rang = d.rappelClient || 0; // 0 = aucun, 1 = premier fait
      const du =
        age < RAPPEL_AGE_MAX_MS &&
        ((rang === 0 && age > RAPPEL_CLIENT_1_MS) || (rang === 1 && age > RAPPEL_CLIENT_2_MS));
      if (du) {
        const to = await jetonDe(d.clientId);
        if (to) {
          envois.push({
            email: 'client:' + d.clientId,
            to,
            titre: '✅ Tu as bien été livré ?',
            corps: `Confirme la livraison de « ${d.titre} » pour clôturer ta commande.`,
          });
        }
        if (!DRY) await doc.ref.update({ rappelClient: rang + 1 }).catch(() => {});
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RELANCES COURSIERS (transactionnel) : une demande toujours « créée » est
// re-poussée à TOUS les coursiers éligibles à ~15 min puis ~30 min (l'app du
// client fait déjà +2 et +4 min ; ce cron en */15 prend le relais app fermée —
// seuils 12/27 pour que le passage suivant du cron tombe dedans).
// Exclusions identiques à l'app : parrain du client (anti-fraude), rejetés,
// comptes test (demandes demoPour ignorées). Au-delà d'1 h : la demande est
// expirée pour les coursiers → plus aucune relance.
// ─────────────────────────────────────────────────────────────────────────────
const RELANCE_1_MS = 12 * MIN; // vise le passage ~15 min
const RELANCE_2_MS = 27 * MIN; // vise le passage ~30 min
const EXPIRATION_MS = 60 * MIN;

async function relancesCoursiers() {
  const snap = await db.collection('demandes').where('statut', '==', 'créée').get().catch(() => ({ docs: [] }));
  const aRelancer = snap.docs.filter((doc) => {
    const d = doc.data();
    if (d.demoPour || d.contreOffre) return false; // test / négociation en cours
    const cree = d.creeLe && d.creeLe.toMillis ? d.creeLe.toMillis() : 0;
    const age = NOW - cree;
    if (!cree || age >= EXPIRATION_MS) return false;
    const rang = d.relanceCoursiers || 0;
    return (rang === 0 && age > RELANCE_1_MS) || (rang === 1 && age > RELANCE_2_MS);
  });
  if (!aRelancer.length) return;

  // Coursiers éligibles (une seule lecture pour toutes les demandes).
  const csnap = await db.collection('utilisateurs').where('role', '==', 'coursier').get();
  const coursiers = csnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter(
      (c) =>
        c.expoPushToken &&
        String(c.expoPushToken).startsWith('ExponentPushToken') &&
        c.statutCoursier !== 'rejete' &&
        !EXCLUS.includes((c.email || '').toLowerCase())
    );

  for (const doc of aRelancer) {
    const d = doc.data();
    const rang = d.relanceCoursiers || 0;
    const [titre, corps] =
      rang === 0
        ? [`💸 ${d.prix} DH t'attendent`, `« ${d.titre} » n'a toujours pas de coursier — premier arrivé, premier servi.`]
        : [`🚨 Dernière chance · ${d.prix} DH`, `« ${d.titre} » expire bientôt — accepte-la maintenant dans Daba.`];
    for (const c of coursiers) {
      if (c.id === d.parrainCoursierId || c.id === d.clientId) continue;
      envois.push({ email: c.email, to: c.expoPushToken, titre, corps, commande: doc.id });
    }
    if (!DRY) await doc.ref.update({ relanceCoursiers: rang + 1 }).catch(() => {});
  }
}

(async () => {
  const h = heureMaroc();
  const jour = jourMaroc();

  // Clients avec token (hors comptes test/démo)
  const usnap = await db.collection('utilisateurs').where('role', '==', 'client').get();
  const clients = usnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    // `invite` = compte fantôme du mode invité (jamais de marketing : pas
    // d'e-mail, pas de consentement — il n'a même pas créé de compte).
    .filter((u) => u.expoPushToken && !u.invite && !EXCLUS.includes((u.email || '').toLowerCase()));

  // Commandes groupées par client
  const dsnap = await db.collection('demandes').get();
  const parClient = {};
  dsnap.docs.forEach((d) => {
    const x = d.data();
    if (x.clientId) (parClient[x.clientId] ||= []).push(x);
  });

  // Localisation d'un client : position GPS enregistrée par l'app, sinon coord de
  // sa dernière demande. Sert à ne notifier QUE les gens au Maroc.
  const localisationDe = (u) => {
    if (u.position && typeof u.position.lat === 'number') return u.position;
    const d = (parClient[u.id] || [])
      .filter((c) => c.coord && typeof c.coord.lat === 'number')
      .sort((a, b) => (b.creeLe?.toMillis?.() || 0) - (a.creeLe?.toMillis?.() || 0))[0];
    return d ? d.coord : null;
  };
  // On garde ceux AU Maroc + ceux dont on ignore encore la position (par défaut,
  // l'app est marocaine). On exclut uniquement ceux localisés HORS Maroc.
  const clientsMaroc = clients.filter((u) => {
    const loc = localisationDe(u);
    return !loc || estAuMaroc(loc);
  });
  const horsMaroc = clients.length - clientsMaroc.length;
  if (horsMaroc) console.log(`${horsMaroc} client(s) hors Maroc exclu(s) du marketing.`);

  const meteo = h >= 11 && h <= 18 ? await meteoDuJour() : { pluie: false, chaud: false };

  for (const u of clientsMaroc) {
    const cmds = parClient[u.id] || [];
    const notifs = u.notifs || {};
    const inscritMs = u.creeLe?.toMillis?.() ?? 0;
    const ageMs = NOW - inscritMs;

    // 1) BIENVENUE — inscrit il y a 1-3 j, aucune commande, pas déjà accueilli
    if (h >= 10 && h <= 20 && !notifs.welcome && cmds.length === 0 && ageMs > JOUR && ageMs < 3 * JOUR) {
      programmer(u, 'Bienvenue sur Daba 👋', `${prenomDe(u)}, ta première demande prend 30 s — on te livre n'importe quoi, même là où les autres ne vont pas.`, { welcome: true }, 'welcome');
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
        programmer(u, 'Envie de te régaler ? 🍔', `Re-commander chez ${derniere.nom} ? En 2 taps sur Daba.`, { recommande: NOW }, 'recommande');
        continue;
      }
    }

    // 3) MÉTÉO — pluie / chaleur, 1 fois par jour max (et jamais 2 jours de suite : cf. `dernier`)
    if ((meteo.pluie || meteo.chaud) && notifs.meteo !== jour) {
      const [titre, corps] = meteo.pluie
        ? ['Il pleut ☔', 'Reste au chaud — fais-toi livrer ce que tu veux avec Daba.']
        : ['Trop chaud pour sortir ? 🥤', "On s'en occupe : commande sur Daba, on te livre."];
      programmer(u, titre, corps, { meteo: jour }, 'meteo:' + (meteo.pluie ? 'pluie' : 'chaud'));
      continue;
    }

    // 4) RÉACTIVATION — aucune activité depuis 14 j, pas relancé depuis 30 j (le soir)
    const derniereActivite = Math.max(inscritMs, ...cmds.map((c) => c.creeLe?.toMillis?.() || 0));
    if (h >= 17 && h <= 19 && NOW - derniereActivite > 14 * JOUR && NOW - (notifs.reactive || 0) > 30 * JOUR) {
      programmer(u, 'Ça fait un moment ! 👀', `${prenomDe(u)}, ta prochaine livraison t'attend. Un petit creux ?`, { reactive: NOW }, 'reactive');
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
      const sig = 'match:' + ev.id;
      const titre = ev.data().titre || '⚽ Ce soir';
      const corps = ev.data().message || "Commande tes snacks avant le coup d'envoi sur Daba.";
      let n = 0;
      for (const u of clientsMaroc) {
        if ((u.notifs || {}).dernier === sig) continue; // déjà reçu cet évènement
        envois.push({ email: u.email, to: u.expoPushToken, titre, corps });
        marqueurs[u.id] = { ...(marqueurs[u.id] || {}), dernier: sig };
        n++;
      }
      if (DRY) console.log(`[DRY_RUN] Évènement « ${titre} » → ${n} clients (au Maroc)`);
      else await ev.ref.update({ envoye: true }).catch(() => {});
    }
  }

  // Rappels de validation (transactionnels) — indépendants du marketing.
  await rappelsValidation();

  // Relances coursiers sur les demandes sans preneur (~15 et ~30 min).
  await relancesCoursiers();

  await envoyerTout();
  process.exit(0);
})().catch((e) => {
  console.error('Erreur :', e.message);
  process.exit(1);
});
