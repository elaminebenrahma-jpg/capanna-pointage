// CAPANNA SMART HR – fonction de pointage (v2)
// Toutes les données passent par ici (clé service). Le pointage n'est accepté
// que depuis le réseau du restaurant (adresse IP enregistrée par le gérant)
// et depuis le téléphone lié à l'employé.
// v2 : horaires lus dans hr_creneaux (doubles services), corrections sans effacement
// avec motif et journal, absences, créneaux, paramètres, rapport basé sur hr_journees.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const TZ = "Africa/Casablanca";
const BASCULE_H = 5; // avant 05h00, on est encore sur la journée de la veille
const JOURS = ["", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const AUTEUR_GERANT = "gérant";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class Refus extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function randomHex(n: number) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------- réseau ----------
function clientIp(req: Request) {
  const xf = req.headers.get("x-forwarded-for") || "";
  return (xf.split(",")[0] || req.headers.get("cf-connecting-ip") || "").trim();
}
function expandV6(ip: string) {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => g.padStart(4, "0").toLowerCase());
}
function reseauDe(ip: string) {
  if (ip.includes(":")) return expandV6(ip).slice(0, 4).join(":") + "::/64";
  return ip;
}
async function reseauOk(ip: string) {
  if (!ip) return false;
  const { data } = await sb.from("hr_reseaux").select("reseau");
  const r = reseauDe(ip);
  return (data || []).some((x) => x.reseau === r);
}

// ---------- heure locale ----------
function local(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, h: +p.hour, m: +p.minute };
}
function jourService(d: Date) {
  return local(new Date(d.getTime() - BASCULE_H * 3600e3)).date;
}
function dow(dateStr: string) { // 1 = lundi
  const d = new Date(dateStr + "T12:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}
function plusJours(dateStr: string, n: number) {
  return new Date(new Date(dateStr + "T12:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
}
// minutes depuis le début de la journée de service (minuit), 01h00 = 25h00
function minutesService(d: Date) {
  const l = local(d);
  const m = l.h * 60 + l.m;
  return l.h < BASCULE_H ? m + 1440 : m;
}
function tMin(t: string | null) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function finMin(debut: string | null, fin: string | null) {
  const d = tMin(debut), f = tMin(fin);
  if (f === null) return null;
  return d !== null && f <= d ? f + 1440 : f;
}
const hhmm = (m: number | null) =>
  m === null || m === undefined ? "" : `${String(Math.floor(m / 60) % 24).padStart(2, "0")}h${String(m % 60).padStart(2, "0")}`;
const heureLocale = (iso: string) => {
  const l = local(new Date(iso));
  return `${String(l.h).padStart(2, "0")}h${String(l.m).padStart(2, "0")}`;
};

// décalage du fuseau (minutes) à un instant donné
function decalage(d: Date) {
  const v = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" })
    .formatToParts(d).find((x) => x.type === "timeZoneName")?.value || "GMT";
  const m = v.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}
// "HH:MM" d'une journée de service -> instant UTC (avant 05h00 = lendemain)
function instantDe(jour: string, heure: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jour)) throw new Refus("Date invalide.");
  const mm = String(heure || "").match(/^(\d{1,2})[:hH](\d{2})$/);
  if (!mm) throw new Refus("Heure invalide (format 14:30).");
  const h = Number(mm[1]), mi = Number(mm[2]);
  if (h > 23 || mi > 59) throw new Refus("Heure invalide.");
  const date = h < BASCULE_H ? plusJours(jour, 1) : jour;
  const [y, mo, d] = date.split("-").map(Number);
  let t = Date.UTC(y, mo - 1, d, h, mi);
  t -= decalage(new Date(t)) * 60e3;
  t = Date.UTC(y, mo - 1, d, h, mi) - decalage(new Date(t)) * 60e3;
  return new Date(t);
}
function heureValide(t: string) {
  const mm = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
  return !!mm && Number(mm[1]) < 24 && Number(mm[2]) < 60;
}
function dateValide(d: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) && !isNaN(new Date(d + "T12:00:00Z").getTime());
}
function motifOk(m: unknown) {
  const s = String(m ?? "").trim();
  if (s.length < 3) throw new Refus("Motif obligatoire (3 caractères minimum).");
  return s;
}

// ---------- paramètres ----------
const PARAMS_MODIFIABLES: Record<string, (v: string) => boolean> = {
  tolerance_retard_min: (v) => /^\d{1,3}$/.test(v) && +v <= 120,
  mode_retard: (v) => ["complet", "deduit"].includes(v),
  seuil_heures_sup_min: (v) => /^\d{1,3}$/.test(v) && +v <= 600,
  mode_heures_sup: (v) => ["complet", "deduit"].includes(v),
  alerte_cumul_1_min: (v) => /^\d{1,4}$/.test(v),
  alerte_cumul_2_min: (v) => /^\d{1,4}$/.test(v),
  debut_suivi: (v) => dateValide(v),
};
async function parametres() {
  const { data } = await sb.from("hr_parametres").select("cle, valeur");
  return Object.fromEntries((data || []).filter((x) => !x.cle.startsWith("admin_")).map((x) => [x.cle, x.valeur]));
}

// ---------- journal (append-only) ----------
async function journal(objet: string, objetId: string | number | null, action: string, ancienne: unknown, nouvelle: unknown, motif: string, auteur = AUTEUR_GERANT): Promise<number> {
  const { data, error } = await sb.from("hr_journal").insert({
    auteur, objet, objet_id: objetId === null ? null : String(objetId), action, ancienne, nouvelle, motif,
  }).select("id").single();
  if (error) throw error;
  return data.id as number;
}

// ---------- horaires (créneaux) ----------
type Creneau = { ordre: number; debut: string; fin: string; pause_min: number };
async function creneauxDu(employeId: number, js: string): Promise<Creneau[]> {
  // planning réellement prévu ce jour-là (modification du jour > semaine type)
  const { data, error } = await sb.rpc("hr_planning_effectif", { p_debut: js, p_fin: js });
  if (error) throw error;
  // deno-lint-ignore no-explicit-any
  return ((data || []) as any[]).filter((x) => x.employe_id === employeId)
    .sort((a, b) => a.ordre - b.ordre).map((x) => ({ ordre: x.ordre, debut: x.debut, fin: x.fin, pause_min: x.pause_min }));
}
const texteCreneaux = (cs: Creneau[]) =>
  cs.length ? cs.map((c) => `${hhmm(tMin(c.debut))}–${hhmm(tMin(c.fin))}`).join(" / ") : "OFF";
function creneauProche(cs: Creneau[], m: number) {
  return [...cs].sort((a, b) => Math.abs(m - tMin(a.debut)!) - Math.abs(m - tMin(b.debut)!) || a.ordre - b.ordre)[0];
}

// ---------- appareil ----------
async function appareil(token: string) {
  if (!token) return null;
  const { data } = await sb.from("hr_appareils")
    .select("id, employe_id, actif, hr_employes(id, nom, service, actif)")
    .eq("token_hash", await sha256(token)).eq("actif", true).maybeSingle();
  // deno-lint-ignore no-explicit-any
  const e = (data as any)?.hr_employes;
  if (!data || !e?.actif) return null;
  return { appareilId: data.id as string, employe: e as { id: number; nom: string; service: string } };
}

async function etatDuJour(employeId: number, js: string) {
  const { data } = await sb.from("hr_pointages").select("type, horodatage")
    .eq("employe_id", employeId).eq("jour_service", js).eq("accepte", true).eq("annule", false).order("horodatage");
  return data || [];
}

// ---------- gérant ----------
async function adminOk(code: string) {
  const { data } = await sb.from("hr_parametres").select("cle, valeur").in("cle", ["admin_hash", "admin_sel"]);
  const p = Object.fromEntries((data || []).map((x) => [x.cle, x.valeur]));
  if (!p.admin_hash || !code) return false;
  return (await sha256(p.admin_sel + code)) === p.admin_hash;
}
async function adminConfigure() {
  const { data } = await sb.from("hr_parametres").select("cle").eq("cle", "admin_hash").maybeSingle();
  return !!data;
}

// ---------- moteur de calcul ----------
type Journee = {
  jour: string; employe_id: number; nom: string; service: string; creneau_ordre: number;
  prevu_debut: string | null; prevu_fin: string | null; pause_min: number;
  arrivee_min: number | null; depart_min: number | null;
  retard_min: number; retard_justifie_min: number; heures_sup_min: number; depart_anticipe_min: number;
  presence_min: number | null; travail_min: number | null; statut: string; absence_type: string | null;
  depart_autorise_min?: number;
};
async function journees(debut: string, fin: string): Promise<Journee[]> {
  if (!dateValide(debut) || !dateValide(fin) || debut > fin) throw new Refus("Période invalide.");
  const out: Journee[] = [];
  // par tranches de 15 jours pour rester sous la limite de lignes de l'API
  for (let d = debut; d <= fin; d = plusJours(d, 15)) {
    const f = plusJours(d, 14) < fin ? plusJours(d, 14) : fin;
    const { data, error } = await sb.rpc("hr_journees", { p_debut: d, p_fin: f });
    if (error) throw error;
    out.push(...((data || []) as Journee[]));
  }
  return out;
}

const LIBELLE_STATUT: Record<string, string> = {
  depart_non_pointe: "Départ non pointé",
  absence_injustifiee: "Absent (aucun pointage)",
  absence_justifiee: "Absence justifiée",
  coupure_non_pointee: "Coupure non pointée",
  hors_planning: "Pointage hors planning",
  absent_en_cours: "Pas encore arrivé",
};

// rapport au format attendu par l'écran gérant actuel
async function rapport(debut: string, fin: string) {
  const js = jourService(new Date());
  const lignes = (await journees(debut, fin))
    .filter((r) => r.statut !== "a_venir" && r.jour <= js)
    .map((r) => {
      const alertes: string[] = [];
      if (LIBELLE_STATUT[r.statut]) alertes.push(LIBELLE_STATUT[r.statut]);
      if (r.retard_min > 0) alertes.push(`Retard ${r.retard_min} min`);
      if (r.retard_justifie_min > 0) alertes.push(`Retard justifié ${r.retard_justifie_min} min`);
      if (r.depart_anticipe_min > 0) alertes.push(`Départ anticipé ${r.depart_anticipe_min} min`);
      if (r.heures_sup_min > 0) alertes.push(`Heures sup ${r.heures_sup_min} min`);
      return {
        jour: r.jour, jour_nom: JOURS[dow(r.jour)], nom: r.nom, service: r.service,
        prevu: r.prevu_debut ? `${hhmm(tMin(r.prevu_debut))}–${hhmm(tMin(r.prevu_fin))}` : "",
        arrivee: hhmm(r.arrivee_min), depart: hhmm(r.depart_min),
        duree_min: r.presence_min, travail_min: r.travail_min,
        retard_min: r.retard_min || null, avance_min: r.depart_anticipe_min || null, depassement_min: r.heures_sup_min || null,
        statut: r.statut, alertes: alertes.join(" · "),
      };
    });
  const { data: emps } = await sb.from("hr_employes").select("id, nom");
  const { data: pts } = await sb.from("hr_pointages").select("employe_id, type, horodatage, jour_service, motif, ip")
    .eq("accepte", false).gte("jour_service", debut).lte("jour_service", fin).order("horodatage");
  const refus = (pts || []).map((x) => ({
    jour: x.jour_service, heure: heureLocale(x.horodatage),
    nom: (emps || []).find((y) => y.id === x.employe_id)?.nom ?? "?", type: x.type, motif: x.motif, ip: x.ip,
  }));
  return { lignes, refus };
}

// ---------- émojis de ponctualité ----------
// Deux indicateurs indépendants, toujours calculés depuis hr_journees (tolérance,
// corrections, doubles services et retards justifiés déjà pris en compte) :
// - jour : ponctualité de l'arrivée sur un créneau ;
// - mois : discipline générale, d'après le nombre et le cumul des retards du mois.
const EMOJIS_DEFAUT = {
  jour: {
    avance_min: 5,          // arrivée au moins 5 min avant l'heure prévue = en avance
    paliers: [10, 30],      // retard 1-10 / 11-30 / plus de 30 minutes
    // smileys dessinés (SVG) : vert, jaune, orange, rouge — jamais d'émoji du clavier
    smileys: { avance: "vert", heure: "vert", justifie: "vert", retard1: "jaune", retard2: "orange", retard3: "rouge" },
    messages: {
      avance: "Excellent ! Tu es même en avance.",
      heure: "Bravo ! Tu es arrivé à l'heure.",
      justifie: "Retard justifié : il n'est pas compté.",
      retard1: "Attention, tu as {retard} minutes de retard.",
      retard2: "Attention, tu as {retard} minutes de retard aujourd'hui.",
      retard3: "Tu as {retard} minutes de retard aujourd'hui.",
    },
  },
  couleurs: { vert: "#2E9E5B", jaune: "#D9A400", orange: "#E2742B", rouge: "#D2453F" },
  mois: {
    // niveau 1 dès le premier retard ; niveaux 2, 3, 4 si le nombre OU le cumul atteint le seuil
    nombre: [3, 5, 8],
    minutes: [60, 180, 300],
    smileys: ["vert", "jaune", "orange", "rouge", "rouge"],
    messages: [
      "Ce mois-ci : aucun retard. Continue comme ça !",
      "Ce mois-ci : {retards}, {cumul} min au total.",
      "Ce mois-ci : retards répétés ({retards}, {cumul} min).",
      "Ce mois-ci : retards importants ({retards}, {cumul} min).",
      "Ce mois-ci : retards très importants ({retards}, {cumul} min).",
    ],
  },
};
type ConfigEmojis = typeof EMOJIS_DEFAUT;
const NIVEAUX = ["vert", "jaune", "orange", "rouge"];
const CLES_JOUR = ["avance", "heure", "justifie", "retard1", "retard2", "retard3"] as const;
type CleJour = typeof CLES_JOUR[number];

function fusion(defaut: ConfigEmojis, x: unknown): ConfigEmojis {
  // deno-lint-ignore no-explicit-any
  const s = (x && typeof x === "object" ? x : {}) as any;
  return {
    jour: {
      avance_min: s.jour?.avance_min ?? defaut.jour.avance_min,
      paliers: s.jour?.paliers ?? defaut.jour.paliers,
      smileys: { ...defaut.jour.smileys, ...(s.jour?.smileys || {}) },
      messages: { ...defaut.jour.messages, ...(s.jour?.messages || {}) },
    },
    couleurs: { ...defaut.couleurs, ...(s.couleurs || {}) },
    mois: {
      nombre: s.mois?.nombre ?? defaut.mois.nombre,
      minutes: s.mois?.minutes ?? defaut.mois.minutes,
      smileys: s.mois?.smileys ?? defaut.mois.smileys,
      messages: s.mois?.messages ?? defaut.mois.messages,
    },
  };
}
function validerConfigEmojis(c: ConfigEmojis) {
  const entier = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
  const croissant = (a: unknown, n: number, max: number) =>
    Array.isArray(a) && a.length === n && a.every((v) => entier(v, max)) && a.every((v, i) => i === 0 || v > a[i - 1]);
  const msg = (s: unknown) => typeof s === "string" && s.trim().length > 0 && s.length <= 160;
  if (!entier(c.jour.avance_min, 120)) throw new Refus("Seuil d'avance invalide (0 à 120 min).");
  if (!croissant(c.jour.paliers, 2, 600)) throw new Refus("Seuils de retard du jour invalides : deux nombres croissants.");
  const niveau = (v: unknown) => typeof v === "string" && NIVEAUX.includes(v);
  if (!NIVEAUX.every((k) => /^#[0-9a-fA-F]{6}$/.test(String((c.couleurs as Record<string, string>)[k] || "")))) throw new Refus("Couleur invalide (format #2E9E5B).");
  if (!CLES_JOUR.every((k) => niveau(c.jour.smileys[k]) && msg(c.jour.messages[k]))) throw new Refus("Smiley ou message du jour invalide.");
  if (!croissant(c.mois.nombre, 3, 100)) throw new Refus("Seuils de nombre de retards invalides : trois nombres croissants.");
  if (!croissant(c.mois.minutes, 3, 10000)) throw new Refus("Seuils de retard cumulé invalides : trois nombres croissants.");
  if (!Array.isArray(c.mois.smileys) || c.mois.smileys.length !== 5 || !c.mois.smileys.every(niveau)) throw new Refus("Il faut 5 smileys pour le mois (vert, jaune, orange ou rouge).");
  if (!Array.isArray(c.mois.messages) || c.mois.messages.length !== 5 || !c.mois.messages.every(msg)) throw new Refus("Il faut 5 messages pour le mois.");
}
async function configEmojis(): Promise<ConfigEmojis> {
  const { data } = await sb.from("hr_parametres").select("valeur").eq("cle", "emojis").maybeSingle();
  try { return fusion(EMOJIS_DEFAUT, data?.valeur ? JSON.parse(data.valeur) : {}); } catch { return EMOJIS_DEFAUT; }
}
const remplir = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

type EmojiJour = { cle: CleJour; smiley: string; couleur: string; message: string; retard_min: number; avance_min: number };
function emojiJour(r: Journee, c: ConfigEmojis): EmojiJour | null {
  if (r.arrivee_min === null || r.arrivee_min === undefined || !r.prevu_debut) return null;
  const ecart = r.arrivee_min - tMin(r.prevu_debut)!;
  let cle: CleJour;
  if (r.retard_min > 0) cle = r.retard_min <= c.jour.paliers[0] ? "retard1" : r.retard_min <= c.jour.paliers[1] ? "retard2" : "retard3";
  else if (r.retard_justifie_min > 0) cle = "justifie";
  else if (ecart <= -c.jour.avance_min) cle = "avance";
  else cle = "heure";
  const avance = ecart < 0 ? -ecart : 0;
  return {
    cle, smiley: c.jour.smileys[cle], couleur: (c.couleurs as Record<string, string>)[c.jour.smileys[cle]], retard_min: r.retard_min, avance_min: avance,
    message: remplir(c.jour.messages[cle], { retard: r.retard_min, avance }),
  };
}
type EmojiMois = { niveau: number; smiley: string; couleur: string; message: string; nb_retards: number; cumul_min: number };
function emojiMois(rows: Journee[], c: ConfigEmojis): EmojiMois {
  // une ligne = un créneau : chaque retard n'est compté qu'une fois
  const ret = rows.filter((r) => r.retard_min > 0);
  const nb = ret.length, cumul = ret.reduce((s, r) => s + r.retard_min, 0);
  let niveau = nb > 0 ? 1 : 0;
  for (let i = 0; i < 3; i++) if (nb >= c.mois.nombre[i] || cumul >= c.mois.minutes[i]) niveau = Math.max(niveau, i + 2);
  return {
    niveau, smiley: c.mois.smileys[niveau], couleur: (c.couleurs as Record<string, string>)[c.mois.smileys[niveau]], nb_retards: nb, cumul_min: cumul,
    message: remplir(c.mois.messages[niveau], { retards: `${nb} retard${nb > 1 ? "s" : ""}`, cumul, nb }),
  };
}
const debutMois = (js: string) => js.slice(0, 8) + "01";
async function emojisEmploye(employeId: number, js: string, c?: ConfigEmojis) {
  const cfg = c || await configEmojis();
  const rows = (await journees(debutMois(js), js)).filter((r) => r.employe_id === employeId);
  const jour = rows.filter((r) => r.jour === js && r.arrivee_min !== null).map((r) => emojiJour(r, cfg)).filter((x) => x);
  return { jour: jour.length ? jour[jour.length - 1] : null, jour_creneaux: jour, mois: emojiMois(rows, cfg) };
}

// ---------- demandes et justificatifs ----------
const TYPES_DEMANDE_EMPLOYE = ["absence_autorisee", "retard_justifie", "depart_anticipe", "conge", "maladie"];
const LIBELLE_TYPE: Record<string, string> = {
  absence_autorisee: "Absence autorisée", retard_justifie: "Retard autorisé", depart_anticipe: "Départ anticipé",
  conge: "Congé", maladie: "Maladie", absence_injustifiee: "Absence injustifiée",
};
const TAILLE_MAX = 5 * 1024 * 1024;
const BUCKET = "justificatifs";

// type réel du fichier d'après ses premiers octets (jamais d'après le nom ou le navigateur)
function typeReel(o: Uint8Array): { mime: string; ext: string } | null {
  if (o.length > 3 && o[0] === 0xff && o[1] === 0xd8 && o[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (o.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => o[i] === v)) return { mime: "image/png", ext: "png" };
  if (o.length > 5 && [0x25, 0x50, 0x44, 0x46, 0x2d].every((v, i) => o[i] === v)) return { mime: "application/pdf", ext: "pdf" };
  return null;
}
// un PDF qui contient du code ou des actions automatiques est refusé
function pdfSuspect(o: Uint8Array) {
  const t = new TextDecoder("latin1").decode(o);
  return /\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA|RichMedia|XFA)\b/.test(t);
}
function deBase64(s: string) {
  const propre = String(s || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(propre)) throw new Refus("Fichier illisible.");
  if (propre.length > Math.ceil(TAILLE_MAX / 3) * 4 + 8) throw new Refus("Fichier trop lourd (5 Mo maximum).");
  const bin = atob(propre);
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}
function enBase64(o: Uint8Array) {
  let s = "";
  for (let i = 0; i < o.length; i += 0x8000) s += String.fromCharCode(...o.subarray(i, i + 0x8000));
  return btoa(s);
}
async function sha256Octets(o: Uint8Array) {
  const b = await crypto.subtle.digest("SHA-256", new Uint8Array(o));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function controlerFichier(base64: string) {
  const o = deBase64(base64);
  if (!o.length) throw new Refus("Fichier vide.");
  if (o.length > TAILLE_MAX) throw new Refus("Fichier trop lourd (5 Mo maximum).");
  const t = typeReel(o);
  if (!t) throw new Refus("Format refusé : JPG, PNG ou PDF uniquement.");
  if (t.mime === "application/pdf" && pdfSuspect(o)) throw new Refus("Ce PDF contient des éléments actifs et a été refusé. Envoie une photo ou un PDF simple.");
  return { octets: o, ...t };
}
async function enregistrerJustificatif(absenceId: number, employeId: number, base64: string, nom: string, deposePar: string) {
  const f = controlerFichier(base64);
  const chemin = `${employeId}/${absenceId}/${crypto.randomUUID()}.${f.ext}`;
  const { error: eUp } = await sb.storage.from(BUCKET).upload(chemin, f.octets, { contentType: f.mime, upsert: false });
  if (eUp) throw eUp;
  // l'ancien justificatif est conservé mais désactivé (remplacement)
  await sb.from("hr_justificatifs").update({ actif: false }).eq("absence_id", absenceId).eq("actif", true);
  const { data, error } = await sb.from("hr_justificatifs").insert({
    absence_id: absenceId, chemin, nom_origine: String(nom || "").slice(0, 120) || null, type_mime: f.mime,
    taille: f.octets.length, sha256: await sha256Octets(f.octets), depose_par: deposePar,
  }).select("id, type_mime, taille, created_at").single();
  if (error) throw error;
  return data;
}
async function lireJustificatif(chemin: string) {
  const { data, error } = await sb.storage.from(BUCKET).download(chemin);
  if (error || !data) throw new Refus("Document introuvable.", 404);
  return enBase64(new Uint8Array(await data.arrayBuffer()));
}
type ExtraNotif = { titre?: string; lien?: string; details?: unknown; cle?: string };
async function notifier(destinataire: string, type: string, absenceId: number | null, message: string, x: ExtraNotif = {}) {
  const ligne = { destinataire, type, absence_id: absenceId, message, titre: x.titre ?? null, lien: x.lien ?? null, details: x.details ?? null, cle: x.cle ?? null };
  // la clé unique empêche les doublons (même événement enregistré deux fois)
  const { error } = x.cle
    ? await sb.from("hr_notifications").upsert(ligne, { onConflict: "cle", ignoreDuplicates: true })
    : await sb.from("hr_notifications").insert(ligne);
  if (error) console.error("notification", error);
}
const dateFr = (d: string) => {
  const x = new Date(d + "T12:00:00Z");
  const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  return `${JOURS[dow(d)]} ${x.getUTCDate()} ${MOIS[x.getUTCMonth()]}`;
};
const periodeFr = (a: string, b: string) => a === b ? `le ${dateFr(a)}` : `du ${dateFr(a)} au ${dateFr(b)}`;

// ---------- notifications push (Web Push : iPhone en appli installée, Android, ordinateur) ----------
let VAPID: { publicKey: string; privateKey: string } | null = null;
async function vapid() {
  if (VAPID) return VAPID;
  const { data } = await sb.from("hr_parametres").select("cle, valeur").in("cle", ["admin_vapid_public", "admin_vapid_prive"]);
  const p = Object.fromEntries((data || []).map((x) => [x.cle, x.valeur]));
  if (!p.admin_vapid_public || !p.admin_vapid_prive) return null;
  VAPID = { publicKey: p.admin_vapid_public, privateKey: p.admin_vapid_prive };
  return VAPID;
}
function lienUrl(n: { destinataire: string; lien: string | null; absence_id: number | null; details: unknown }) {
  // deno-lint-ignore no-explicit-any
  const d = (n.details || {}) as any;
  if (n.destinataire === "gerant") return n.absence_id ? `v2.html#gerant/demande/${n.absence_id}` : "v2.html#gerant";
  if (n.lien === "planning") return `v2.html#e/planning${d.date ? "/" + String(d.date).slice(0, 10) : ""}`;
  if (n.lien === "demandes") return "v2.html#e/demandes";
  return "v2.html#e/notifications";
}
// Envoie les notifications en attente. Chaque notification est « réservée » avant l'envoi :
// deux appels simultanés ne peuvent pas l'envoyer deux fois. 3 essais maximum.
async function envoyerPush() {
  const cles = await vapid();
  if (!cles) return;
  const depuis = new Date(Date.now() - 2 * 864e5).toISOString();
  const { data } = await sb.from("hr_notifications").select("id, destinataire, titre, message, lien, absence_id, details, push_tentatives")
    .in("push_statut", ["a_envoyer", "echec_temp"]).lt("push_tentatives", 3).gte("created_at", depuis).order("id").limit(40);
  for (const n of data || []) {
    const { data: pris } = await sb.from("hr_notifications")
      .update({ push_statut: "envoi", push_tentatives: n.push_tentatives + 1, push_essai_le: new Date().toISOString() })
      .eq("id", n.id).in("push_statut", ["a_envoyer", "echec_temp"]).select("id");
    if (!pris?.length) continue;
    const { data: abos } = await sb.from("hr_push_abonnements").select("id, endpoint, p256dh, auth, echecs")
      .eq("destinataire", n.destinataire).eq("actif", true);
    if (!abos?.length) { await sb.from("hr_notifications").update({ push_statut: "sans_abonnement" }).eq("id", n.id); continue; }
    const charge = JSON.stringify({ id: n.id, titre: n.titre || "Capanna", message: n.message, url: lienUrl(n) });
    let ok = 0, temporaire = false;
    const erreurs: string[] = [];
    for (const a of abos) {
      try {
        const req = webpush.generateRequestDetails({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } }, charge, {
          vapidDetails: { subject: "mailto:contact@keynet.app", publicKey: cles.publicKey, privateKey: cles.privateKey },
          TTL: 86400, urgency: "high", topic: `n${n.id}`,
        });
        const r = await fetch(req.endpoint, { method: "POST", headers: req.headers as Record<string, string>, body: new Uint8Array(req.body as Uint8Array) });
        if (r.ok) { ok++; await sb.from("hr_push_abonnements").update({ dernier_envoi: new Date().toISOString(), echecs: 0 }).eq("id", a.id); }
        else if (r.status === 404 || r.status === 410) { await sb.from("hr_push_abonnements").update({ actif: false, maj_le: new Date().toISOString() }).eq("id", a.id); erreurs.push(`abonnement expiré (${r.status})`); }
        else { temporaire = temporaire || r.status === 429 || r.status >= 500; erreurs.push(`HTTP ${r.status}`); await sb.from("hr_push_abonnements").update({ echecs: a.echecs + 1 }).eq("id", a.id); }
      } catch (e) { temporaire = true; erreurs.push(String((e as Error)?.message || e).slice(0, 120)); }
    }
    await sb.from("hr_notifications").update({
      push_statut: ok ? "envoye" : temporaire ? "echec_temp" : "echec",
      push_erreur: erreurs.length ? erreurs.join(" ; ").slice(0, 400) : null,
    }).eq("id", n.id);
  }
}
async function pousser() { try { await envoyerPush(); } catch (e) { console.error("push", e); } }
function abonnementValide(x: unknown) {
  // deno-lint-ignore no-explicit-any
  const a = x as any;
  const ok = a && typeof a.endpoint === "string" && /^https:\/\//.test(a.endpoint) && a.endpoint.length < 1000
    && typeof a.keys?.p256dh === "string" && typeof a.keys?.auth === "string" && a.keys.p256dh.length < 200 && a.keys.auth.length < 100;
  if (!ok) throw new Refus("Abonnement aux notifications invalide.");
  return { endpoint: a.endpoint as string, p256dh: a.keys.p256dh as string, auth: a.keys.auth as string };
}
async function abonner(destinataire: string, appareilId: string | null, abo: unknown, ua: string | null) {
  const a = abonnementValide(abo);
  const { error } = await sb.from("hr_push_abonnements").upsert({
    destinataire, appareil_id: appareilId, ...a, user_agent: ua?.slice(0, 200) ?? null, actif: true, maj_le: new Date().toISOString(), echecs: 0,
  }, { onConflict: "endpoint" });
  if (error) throw error;
}
const CHAMPS_NOTIF = "id, type, titre, message, lien, details, absence_id, lu, lu_le, created_at";
const heureOuNull = (h: unknown) => {
  if (h === undefined || h === null || h === "") return null;
  if (!heureValide(String(h))) throw new Refus("Heure invalide (format 14:30).");
  return String(h);
};
const champ = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max) || null;
// deno-lint-ignore no-explicit-any
function avecManquant(d: any) {
  // deno-lint-ignore no-explicit-any
  const actifs = (d.hr_justificatifs || []).filter((j: any) => j.actif);
  return { ...d, hr_justificatifs: actifs, justificatif_manquant: !!d.justificatif_requis && actifs.length === 0 };
}
const SELECT_DEMANDE = "id, employe_id, type, date_debut, date_fin, heure_debut, heure_fin, motif, explication, commentaire, statut, commentaire_decision, justificatif_requis, demande_par, decide_par, decide_le, created_at, maj_le, hr_justificatifs(id, type_mime, taille, nom_origine, actif, created_at)";

const TYPES_ABSENCE = ["conge", "maladie", "absence_autorisee", "absence_injustifiee", "retard_justifie", "depart_anticipe"];

// ---------- serveur ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erreur: "POST uniquement" }, 405);
  // deno-lint-ignore no-explicit-any
  let b: Record<string, any> = {};
  try { b = await req.json(); } catch { return json({ erreur: "Requête invalide" }, 400); }
  const ip = clientIp(req);
  const wifi = await reseauOk(ip);
  const now = new Date();
  const js = jourService(now);

  try {
    switch (b.action) {
      case "init": {
        const a = await appareil(b.token);
        let moi = null;
        if (a) {
          const cs = await creneauxDu(a.employe.id, js);
          let emojis = null;
          try { emojis = await emojisEmploye(a.employe.id, js); } catch (e) { console.error("emojis", e); }
          const { count } = await sb.from("hr_notifications").select("id", { count: "exact", head: true }).eq("destinataire", `employe:${a.employe.id}`).eq("lu", false);
          moi = { nom: a.employe.nom, service: a.employe.service, prevu: texteCreneaux(cs), aujourdhui: await etatDuJour(a.employe.id, js), emojis, non_lues: count || 0, vapid: (await vapid())?.publicKey || null };
        }
        let employes: unknown[] = [];
        if (!a && wifi) {
          const { data } = await sb.from("hr_employes").select("id, nom, service").eq("actif", true).order("service").order("nom");
          employes = data || [];
        }
        return json({ wifi, moi, employes, jour_service: js, jour_nom: JOURS[dow(js)] });
      }

      case "enregistrer": {
        if (!wifi) return json({ erreur: "Connecte-toi au Wi-Fi Capanna pour activer ton téléphone." }, 403);
        const id = Number(b.employe_id);
        const { data: e } = await sb.from("hr_employes").select("id, nom, pin, actif").eq("id", id).maybeSingle();
        if (!e || !e.actif || e.pin !== String(b.pin || "")) return json({ erreur: "Code incorrect." }, 403);
        const { data: deja } = await sb.from("hr_appareils").select("id").eq("employe_id", id).eq("actif", true).maybeSingle();
        if (deja) return json({ erreur: "Un téléphone est déjà enregistré à ton nom. Demande au gérant de le réinitialiser." }, 409);
        const token = randomHex(32);
        const { error } = await sb.from("hr_appareils").insert({ employe_id: id, token_hash: await sha256(token), user_agent: req.headers.get("user-agent")?.slice(0, 200) });
        if (error) throw error;
        return json({ ok: true, token, nom: e.nom });
      }

      case "pointer": {
        const a = await appareil(b.token);
        if (!a) return json({ erreur: "Téléphone non reconnu. Demande au gérant." }, 403);
        const type = b.type === "depart" ? "depart" : "arrivee";
        if (!wifi) {
          await sb.from("hr_pointages").insert({ employe_id: a.employe.id, type, jour_service: js, ip, appareil_id: a.appareilId, accepte: false, motif: "Hors Wi-Fi Capanna" });
          return json({ erreur: "Pointage refusé : tu n'es pas sur le Wi-Fi Capanna. Connecte-toi au Wi-Fi du restaurant puis réessaie." }, 403);
        }
        const jour = await etatDuJour(a.employe.id, js);
        const dernier = jour[jour.length - 1];
        if (type === "arrivee" && dernier?.type === "arrivee") return json({ erreur: "Ton arrivée est déjà pointée." }, 409);
        if (type === "depart" && dernier?.type !== "arrivee") return json({ erreur: "Pointe d'abord ton arrivée." }, 409);
        const { error } = await sb.from("hr_pointages").insert({ employe_id: a.employe.id, type, horodatage: now.toISOString(), jour_service: js, ip, appareil_id: a.appareilId, accepte: true });
        if (error) throw error;
        const cs = await creneauxDu(a.employe.id, js);
        const tol = Number((await parametres()).tolerance_retard_min ?? 5);
        const m = minutesService(now);
        let info = "";
        if (!cs.length) info = "Attention : aujourd'hui n'est pas prévu à ton planning.";
        else if (type === "arrivee") {
          const c = creneauProche(cs, m);
          const r = m - tMin(c.debut)!;
          info = r > tol ? `Retard de ${r} min (prévu ${hhmm(tMin(c.debut))}).` : "À l'heure. Bon service !";
        } else {
          const arr = jour.filter((x) => x.type === "arrivee").pop();
          const c = creneauProche(cs, arr ? minutesService(new Date(arr.horodatage)) : m);
          const f = finMin(c.debut, c.fin)!;
          info = f - m > 5 ? `Départ ${f - m} min avant l'heure prévue (${hhmm(f)}).` : "Merci, bonne fin de service !";
          if (cs.length > 1 && c.ordre < cs[cs.length - 1].ordre) info += " Pense à pointer ton arrivée au prochain service.";
        }
        const l = local(now);
        // émojis : calculés après l'enregistrement ; une erreur ici ne bloque jamais le pointage
        let emojis = null;
        try { emojis = await emojisEmploye(a.employe.id, js); } catch (e) { console.error("emojis", e); }
        return json({ ok: true, type, heure: `${String(l.h).padStart(2, "0")}h${String(l.m).padStart(2, "0")}`, info, emojis, aujourdhui: await etatDuJour(a.employe.id, js) });
      }

      // ----- employé : mes demandes -----
      case "demande_creer":
      case "demander_absence": {
        const a = await appareil(b.token);
        if (!a) return json({ erreur: "Téléphone non reconnu. Demande au gérant." }, 403);
        const type = String(b.type || "");
        if (!TYPES_DEMANDE_EMPLOYE.includes(type)) throw new Refus("Type de demande invalide.");
        const debut = b.date_debut || b.date, fin = b.date_fin || debut;
        if (!dateValide(debut) || !dateValide(fin) || fin < debut) throw new Refus("Dates invalides.");
        const motif = champ(b.motif ?? b.commentaire, 200);
        if (!motif || motif.length < 3) throw new Refus("Indique le motif de ta demande.");
        const hd = heureOuNull(b.heure_debut), hf = heureOuNull(b.heure_fin);
        if (type === "retard_justifie" && hd && !hf) throw new Refus("Indique l'heure d'arrivée prévue.");
        const { data, error } = await sb.from("hr_absences").insert({
          employe_id: a.employe.id, type, date_debut: debut, date_fin: fin, heure_debut: hd, heure_fin: hf,
          motif, explication: champ(b.explication, 1000), demande_par: "employe", statut: "demandee",
          justificatif_requis: type === "maladie",
        }).select("id").single();
        if (error) throw error;
        let justificatif = null;
        if (b.fichier) justificatif = await enregistrerJustificatif(data.id, a.employe.id, b.fichier, b.nom_fichier, "employe");
        await notifier("gerant", "nouvelle_demande", data.id, `${a.employe.nom} : ${LIBELLE_TYPE[type]} ${periodeFr(debut, fin)}. Motif : ${motif}`,
          { titre: "Nouvelle demande à traiter", lien: "demande", cle: `demande:${data.id}` });
        await pousser();
        return json({ ok: true, id: data.id, justificatif });
      }
      case "demande_justificatif": {
        // ajoute ou remplace la pièce jointe d'une demande non encore décidée
        const a = await appareil(b.token);
        if (!a) return json({ erreur: "Téléphone non reconnu. Demande au gérant." }, 403);
        const { data: d } = await sb.from("hr_absences").select("id, employe_id, statut, type, date_debut").eq("id", Number(b.id)).maybeSingle();
        if (!d || d.employe_id !== a.employe.id) throw new Refus("Demande introuvable.", 404);
        if (!["demandee", "complement"].includes(d.statut)) throw new Refus("Cette demande est déjà traitée : le justificatif ne peut plus être changé.", 409);
        const justificatif = await enregistrerJustificatif(d.id, a.employe.id, b.fichier, b.nom_fichier, "employe");
        if (d.statut === "complement") await sb.from("hr_absences").update({ statut: "demandee", maj_le: new Date().toISOString() }).eq("id", d.id);
        await notifier("gerant", "justificatif_recu", d.id, `${a.employe.nom} a envoyé un justificatif (${LIBELLE_TYPE[d.type]} du ${dateFr(d.date_debut)}).`,
          { titre: "Justificatif reçu", lien: "demande" });
        await pousser();
        return json({ ok: true, justificatif });
      }
      case "mes_demandes":
      case "mes_absences": {
        const a = await appareil(b.token);
        if (!a) return json({ erreur: "Téléphone non reconnu. Demande au gérant." }, 403);
        const { data, error } = await sb.from("hr_absences").select(SELECT_DEMANDE)
          .eq("employe_id", a.employe.id).order("created_at", { ascending: false }).limit(100);
        if (error) throw error;
        const demandes = (data || []).map(avecManquant);
        return json({ ok: true, demandes, absences: demandes });
      }
      case "mon_justificatif": {
        const a = await appareil(b.token);
        if (!a) return json({ erreur: "Téléphone non reconnu. Demande au gérant." }, 403);
        const { data: j } = await sb.from("hr_justificatifs").select("id, chemin, type_mime, hr_absences(employe_id)").eq("id", Number(b.id)).maybeSingle();
        // deno-lint-ignore no-explicit-any
        if (!j || (j as any).hr_absences?.employe_id !== a.employe.id) throw new Refus("Document introuvable.", 404);
        return json({ ok: true, type_mime: j.type_mime, fichier: await lireJustificatif(j.chemin) });
      }
      case "demande_annuler": {
        const a = await appareil(b.token);
        if (!a) return json({ erreur: "Téléphone non reconnu. Demande au gérant." }, 403);
        const { data: d } = await sb.from("hr_absences").select("id, employe_id, statut").eq("id", Number(b.id)).maybeSingle();
        if (!d || d.employe_id !== a.employe.id) throw new Refus("Demande introuvable.", 404);
        if (!["demandee", "complement"].includes(d.statut)) throw new Refus("Seule une demande en attente peut être annulée.", 409);
        await sb.from("hr_absences").update({ statut: "annulee", maj_le: new Date().toISOString() }).eq("id", d.id);
        await journal("absence", d.id, "annulation", { statut: d.statut }, { statut: "annulee" }, "Annulée par l'employé", `employe:${a.employe.id}`);
        return json({ ok: true });
      }
      case "mes_notifications": {
        const a = await appareil(b.token);
        if (!a) return json({ erreur: "Téléphone non reconnu. Demande au gérant." }, 403);
        const dest = `employe:${a.employe.id}`;
        const { data } = await sb.from("hr_notifications").select(CHAMPS_NOTIF)
          .eq("destinataire", dest).order("created_at", { ascending: false }).limit(Math.min(Number(b.limite) || 100, 300));
        if (b.marquer_lues) await sb.from("hr_notifications").update({ lu: true, lu_le: new Date().toISOString() }).eq("destinataire", dest).eq("lu", false);
        const { count } = await sb.from("hr_notifications").select("id", { count: "exact", head: true }).eq("destinataire", dest).eq("lu", false);
        return json({ ok: true, notifications: data || [], non_lues: count || 0 });
      }
      case "notification_lue": {
        const a = await appareil(b.token);
        if (!a) return json({ erreur: "Téléphone non reconnu. Demande au gérant." }, 403);
        // uniquement ses propres notifications
        await sb.from("hr_notifications").update({ lu: true, lu_le: new Date().toISOString() })
          .eq("id", Number(b.id)).eq("destinataire", `employe:${a.employe.id}`).eq("lu", false);
        const { count } = await sb.from("hr_notifications").select("id", { count: "exact", head: true }).eq("destinataire", `employe:${a.employe.id}`).eq("lu", false);
        return json({ ok: true, non_lues: count || 0 });
      }
      case "mon_planning": {
        // lecture seule : uniquement le planning de l'employé lié à ce téléphone
        const a = await appareil(b.token);
        if (!a) return json({ erreur: "Téléphone non reconnu. Demande au gérant." }, 403);
        const debut = dateValide(b.debut) ? String(b.debut) : plusJours(js, 1 - dow(js));
        const fin = dateValide(b.fin) ? String(b.fin) : plusJours(debut, 6);
        if (fin < debut || plusJours(debut, 62) < fin) throw new Refus("Période invalide (2 mois maximum).");
        const id = a.employe.id;
        const [pe, abs, att] = await Promise.all([
          sb.rpc("hr_planning_effectif", { p_debut: debut, p_fin: fin }),
          sb.from("hr_absences").select("id, type, date_debut, date_fin, heure_debut, heure_fin")
            .eq("employe_id", id).eq("statut", "validee").lte("date_debut", fin).gte("date_fin", debut),
          sb.from("hr_absences").select("id, type, date_debut, date_fin")
            .eq("employe_id", id).in("statut", ["demandee", "complement"]).lte("date_debut", fin).gte("date_fin", debut),
        ]);
        for (const r of [pe, abs, att]) if (r.error) throw r.error;
        // deno-lint-ignore no-explicit-any
        const planning = ((pe.data || []) as any[]).filter((x) => x.employe_id === id)
          .map((x) => ({ jour: x.jour, ordre: x.ordre, debut: String(x.debut).slice(0, 5), fin: String(x.fin).slice(0, 5), pause_min: x.pause_min, source: x.source }));
        return json({ ok: true, debut, fin, jour_service: js, nom: a.employe.nom, service: a.employe.service, planning, absences: abs.data || [], en_attente: att.data || [] });
      }
      case "push_abonner": {
        const a = await appareil(b.token);
        if (!a) return json({ erreur: "Téléphone non reconnu. Demande au gérant." }, 403);
        await abonner(`employe:${a.employe.id}`, a.appareilId, b.abonnement, req.headers.get("user-agent"));
        await notifier(`employe:${a.employe.id}`, "push_active", null, "Tu recevras ici les changements de ton planning et les réponses à tes demandes.", { titre: "Notifications activées", lien: "notifications" });
        await pousser();
        return json({ ok: true });
      }
      case "push_desabonner": {
        const a = await appareil(b.token);
        if (!a) return json({ erreur: "Téléphone non reconnu. Demande au gérant." }, 403);
        await sb.from("hr_push_abonnements").update({ actif: false, maj_le: new Date().toISOString() }).eq("endpoint", String(b.endpoint || "")).eq("destinataire", `employe:${a.employe.id}`);
        return json({ ok: true });
      }

      // ----- gérant -----
      case "admin_statut":
        return json({ configure: await adminConfigure(), wifi, ip_vue: reseauDe(ip) });

      case "admin_creer": {
        if (await adminConfigure()) return json({ erreur: "Le code gérant existe déjà." }, 409);
        if (!b.code || String(b.code).length < 6) return json({ erreur: "Choisis un code d'au moins 6 caractères." }, 400);
        const sel = randomHex(16);
        await sb.from("hr_parametres").insert([{ cle: "admin_sel", valeur: sel }, { cle: "admin_hash", valeur: await sha256(sel + b.code) }]);
        return json({ ok: true });
      }
    }

    if (String(b.action || "").startsWith("admin_")) {
      if (!(await adminOk(b.code))) return json({ erreur: "Code gérant incorrect." }, 403);
      switch (b.action) {
        case "admin_connexion": {
          const { data: res } = await sb.from("hr_reseaux").select("reseau, libelle, created_at").order("id");
          return json({ ok: true, wifi, ip_vue: reseauDe(ip), reseaux: res || [] });
        }
        case "admin_ajouter_wifi": {
          const r = reseauDe(ip);
          if (!r) return json({ erreur: "Adresse introuvable." }, 400);
          await sb.from("hr_reseaux").upsert({ reseau: r, libelle: b.libelle || "Wi-Fi Capanna" }, { onConflict: "reseau" });
          await journal("reseau", r, "ajout", null, { reseau: r }, "Ajout du réseau depuis l'espace gérant");
          return json({ ok: true, reseau: r });
        }
        case "admin_retirer_wifi": {
          await sb.from("hr_reseaux").delete().eq("reseau", b.reseau);
          await journal("reseau", b.reseau, "suppression", { reseau: b.reseau }, null, "Retrait du réseau depuis l'espace gérant");
          return json({ ok: true });
        }
        case "admin_equipe": {
          const { data: emps } = await sb.from("hr_employes").select("id, nom, service, pin, actif").order("id");
          const { data: apps } = await sb.from("hr_appareils").select("employe_id, created_at").eq("actif", true);
          const jour = await sb.from("hr_pointages").select("employe_id, type, horodatage").eq("jour_service", js).eq("accepte", true).eq("annule", false).order("horodatage");
          return json({
            jour_service: js,
            equipe: (emps || []).map((e) => {
              const pts = (jour.data || []).filter((x) => x.employe_id === e.id);
              const last = pts[pts.length - 1];
              return { ...e, telephone: (apps || []).some((x) => x.employe_id === e.id), present: last?.type === "arrivee" };
            }),
          });
        }
        case "admin_reinitialiser": {
          const id = Number(b.employe_id);
          const { data: apps } = await sb.from("hr_appareils").select("id").eq("employe_id", id).eq("actif", true);
          await sb.from("hr_appareils").update({ actif: false, revoque_le: new Date().toISOString() }).eq("employe_id", id).eq("actif", true);
          if (apps?.length) await sb.from("hr_push_abonnements").update({ actif: false, maj_le: new Date().toISOString() }).in("appareil_id", apps.map((x) => x.id));
          await journal("appareil", id, "reinitialisation", null, null, String(b.motif || "").trim().length >= 3 ? String(b.motif).trim() : "Réinitialisation du téléphone par le gérant");
          return json({ ok: true });
        }
        case "admin_nouveau_code": {
          const pin = String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
          await sb.from("hr_employes").update({ pin }).eq("id", Number(b.employe_id));
          await journal("employe", Number(b.employe_id), "nouveau_code", null, null, "Nouveau code d'activation généré");
          return json({ ok: true, pin });
        }
        case "admin_rapport": {
          const debut = b.debut || js, fin = b.fin || js;
          return json({ ok: true, ...(await rapport(debut, fin)) });
        }

        // --- moteur de calcul brut (tableau de bord, fiches) ---
        case "admin_journees": {
          let rows = await journees(b.debut || js, b.fin || js);
          if (b.employe_id) rows = rows.filter((r) => r.employe_id === Number(b.employe_id));
          const cfg = await configEmojis();
          return json({ ok: true, jour_service: js, journees: rows.map((r) => ({ ...r, emoji_jour: emojiJour(r, cfg) })) });
        }

        // --- émojis : discipline du mois par employé (tableau de bord, fiches) ---
        case "admin_emojis_mois": {
          const mois = /^\d{4}-\d{2}$/.test(String(b.mois || "")) ? String(b.mois) : js.slice(0, 7);
          const debut = `${mois}-01`;
          const finMois = new Date(Date.UTC(Number(mois.slice(0, 4)), Number(mois.slice(5, 7)), 0)).toISOString().slice(0, 10);
          const fin = finMois < js ? finMois : js;
          if (fin < debut) return json({ ok: true, mois, employes: [] });
          const cfg = await configEmojis();
          const rows = await journees(debut, fin);
          const { data: emps } = await sb.from("hr_employes").select("id, nom, service").eq("actif", true).order("nom");
          return json({
            ok: true, mois,
            employes: (emps || []).map((e) => ({ ...e, ...emojiMois(rows.filter((r) => r.employe_id === e.id), cfg) })),
          });
        }
        case "admin_emojis_config":
          return json({ ok: true, config: await configEmojis(), defaut: EMOJIS_DEFAUT });
        case "admin_emojis_config_modifier": {
          const motif = motifOk(b.motif);
          const avant = await configEmojis();
          const nouvelle = b.defaut === true ? EMOJIS_DEFAUT : fusion(avant, b.config);
          validerConfigEmojis(nouvelle);
          const { error } = await sb.from("hr_parametres").upsert({ cle: "emojis", valeur: JSON.stringify(nouvelle) }, { onConflict: "cle" });
          if (error) throw error;
          await journal("parametre", "emojis", "modification", avant, nouvelle, motif);
          return json({ ok: true, config: nouvelle });
        }

        // --- pointages : consultation et corrections sans effacement ---
        case "admin_pointages": {
          const debut = b.debut || js, fin = b.fin || debut;
          if (!dateValide(debut) || !dateValide(fin)) throw new Refus("Période invalide.");
          let q = sb.from("hr_pointages").select("id, employe_id, type, horodatage, jour_service, accepte, motif, source, annule, remplace_id, ip")
            .gte("jour_service", debut).lte("jour_service", fin).order("horodatage");
          if (b.employe_id) q = q.eq("employe_id", Number(b.employe_id));
          const { data, error } = await q;
          if (error) throw error;
          return json({ ok: true, pointages: (data || []).map((x) => ({ ...x, heure: heureLocale(x.horodatage) })) });
        }
        case "admin_pointage_ajouter": {
          const motif = motifOk(b.motif);
          const employeId = Number(b.employe_id);
          const type = b.type === "depart" ? "depart" : b.type === "arrivee" ? "arrivee" : null;
          if (!type) throw new Refus("Type invalide (arrivee ou depart).");
          const { data: e } = await sb.from("hr_employes").select("id").eq("id", employeId).maybeSingle();
          if (!e) throw new Refus("Employé introuvable.", 404);
          const t = instantDe(b.jour, b.heure);
          const { data, error } = await sb.from("hr_pointages").insert({
            employe_id: employeId, type, horodatage: t.toISOString(), jour_service: b.jour, accepte: true, source: "manuel", motif,
          }).select("id").single();
          if (error) throw error;
          await journal("pointage", data.id, "ajout", null, { employe_id: employeId, type, jour: b.jour, heure: heureLocale(t.toISOString()) }, motif);
          return json({ ok: true, id: data.id });
        }
        case "admin_pointage_corriger": {
          const motif = motifOk(b.motif);
          const { data: old } = await sb.from("hr_pointages").select("*").eq("id", Number(b.id)).maybeSingle();
          if (!old) throw new Refus("Pointage introuvable.", 404);
          if (old.annule) throw new Refus("Ce pointage est déjà annulé ou corrigé.", 409);
          if (!old.accepte) throw new Refus("Un pointage refusé ne se corrige pas : ajoute un pointage manuel.", 409);
          const t = instantDe(old.jour_service, b.heure);
          const { data: nv, error } = await sb.from("hr_pointages").insert({
            employe_id: old.employe_id, type: old.type, horodatage: t.toISOString(), jour_service: old.jour_service,
            accepte: true, source: "manuel", motif, remplace_id: old.id, appareil_id: old.appareil_id,
          }).select("id").single();
          if (error) throw error;
          const { error: e2 } = await sb.from("hr_pointages").update({ annule: true }).eq("id", old.id);
          if (e2) throw e2;
          await journal("pointage", old.id, "modification",
            { id: old.id, type: old.type, jour: old.jour_service, heure: heureLocale(old.horodatage) },
            { id: nv.id, type: old.type, jour: old.jour_service, heure: heureLocale(t.toISOString()) }, motif);
          return json({ ok: true, id: nv.id });
        }
        case "admin_pointage_annuler": {
          const motif = motifOk(b.motif);
          const { data: old } = await sb.from("hr_pointages").select("*").eq("id", Number(b.id)).maybeSingle();
          if (!old) throw new Refus("Pointage introuvable.", 404);
          if (old.annule) throw new Refus("Ce pointage est déjà annulé.", 409);
          const { error } = await sb.from("hr_pointages").update({ annule: true }).eq("id", old.id);
          if (error) throw error;
          await journal("pointage", old.id, "annulation",
            { id: old.id, type: old.type, jour: old.jour_service, heure: heureLocale(old.horodatage) }, null, motif);
          return json({ ok: true });
        }

        // --- horaires ---
        case "admin_creneaux": {
          let q = sb.from("hr_creneaux").select("id, employe_id, jour, ordre, debut, fin, pause_min").eq("actif", true).order("employe_id").order("jour").order("ordre");
          if (b.employe_id) q = q.eq("employe_id", Number(b.employe_id));
          const { data, error } = await q;
          if (error) throw error;
          return json({ ok: true, creneaux: data || [] });
        }
        case "admin_creneaux_enregistrer": {
          // remplace les créneaux d'un employé pour un jour de la semaine ; liste vide = jour OFF
          const motif = motifOk(b.motif);
          const employeId = Number(b.employe_id), jour = Number(b.jour);
          if (!(jour >= 1 && jour <= 7)) throw new Refus("Jour invalide (1 = lundi … 7 = dimanche).");
          const liste = Array.isArray(b.creneaux) ? b.creneaux : [];
          if (liste.length > 4) throw new Refus("4 créneaux maximum par jour.");
          // deno-lint-ignore no-explicit-any
          const propres = liste.map((c: any) => {
            if (!heureValide(c.debut) || !heureValide(c.fin)) throw new Refus("Heures invalides (format 14:30).");
            const pause = Number(c.pause_min || 0);
            if (!(pause >= 0 && pause <= 240)) throw new Refus("Pause invalide.");
            return { debut: c.debut, fin: c.fin, pause_min: pause };
          }).sort((x: { debut: string }, y: { debut: string }) => tMin(x.debut)! - tMin(y.debut)!);
          const { data: avant } = await sb.from("hr_creneaux").select("id, ordre, debut, fin, pause_min, actif").eq("employe_id", employeId).eq("jour", jour);
          const anciens = (avant || []).filter((x) => x.actif).sort((x, y) => x.ordre - y.ordre);
          for (let i = 0; i < propres.length; i++) {
            const ordre = i + 1;
            const ex = (avant || []).find((x) => x.ordre === ordre);
            const { error } = ex
              ? await sb.from("hr_creneaux").update({ ...propres[i], actif: true }).eq("id", ex.id)
              : await sb.from("hr_creneaux").insert({ employe_id: employeId, jour, ordre, ...propres[i] });
            if (error) throw error;
          }
          const surplus = (avant || []).filter((x) => x.ordre > propres.length && x.actif).map((x) => x.id);
          if (surplus.length) {
            const { error } = await sb.from("hr_creneaux").update({ actif: false }).in("id", surplus);
            if (error) throw error;
          }
          const jid = await journal("creneaux", `${employeId}-${jour}`, "modification",
            anciens.map((x) => ({ debut: x.debut, fin: x.fin, pause_min: x.pause_min })), propres, motif);
          // l'employé est prévenu, à partir du prochain jour concerné
          const prochain = plusJours(js, (jour - dow(js) + 7) % 7);
          const hm = (t: string) => String(t).slice(0, 5);
          const { error: eN } = await sb.rpc("hr_notifier_planning", {
            p_emp: employeId, p_jour: prochain, p_portee: "suivantes", p_journal: jid,
            p_avant: anciens.map((x) => ({ debut: hm(x.debut), fin: hm(x.fin), pause_min: x.pause_min })),
            p_apres: propres.map((x: { debut: string; fin: string; pause_min: number }) => ({ debut: hm(x.debut.padStart(5, "0")), fin: hm(x.fin.padStart(5, "0")), pause_min: x.pause_min })),
          });
          if (eN) console.error("notification planning", eN);
          await pousser();
          return json({ ok: true });
        }

        // --- planning hebdomadaire (consultation + modification groupée) ---
        case "admin_planning": {
          const js = jourService(new Date());
          let lundi = dateValide(b.lundi) ? String(b.lundi) : js;
          lundi = plusJours(lundi, 1 - dow(lundi));
          const dimanche = plusJours(lundi, 6);
          const [pe, emps, abs, att] = await Promise.all([
            sb.rpc("hr_planning_effectif", { p_debut: lundi, p_fin: dimanche }),
            sb.from("hr_employes").select("id, nom, service, actif").order("service").order("nom"),
            sb.from("hr_absences").select("id, employe_id, type, date_debut, date_fin, heure_debut, heure_fin, motif")
              .eq("statut", "validee").lte("date_debut", dimanche).gte("date_fin", lundi),
            sb.from("hr_absences").select("id, employe_id, type, date_debut, date_fin")
              .in("statut", ["demandee", "complement"]).lte("date_debut", dimanche).gte("date_fin", lundi),
          ]);
          for (const r of [pe, emps, abs, att]) if (r.error) throw r.error;
          // deno-lint-ignore no-explicit-any
          const planning = ((pe.data || []) as any[]).map((x) => ({ jour: x.jour, employe_id: x.employe_id, ordre: x.ordre,
            debut: String(x.debut).slice(0, 5), fin: String(x.fin).slice(0, 5), pause_min: x.pause_min, source: x.source }));
          const avecPlanning = new Set(planning.map((x) => x.employe_id));
          // deno-lint-ignore no-explicit-any
          const employes = ((emps.data || []) as any[]).filter((e) => e.actif || avecPlanning.has(e.id));
          return json({ ok: true, lundi, dimanche, jour_service: js, employes, planning, absences: abs.data || [], en_attente: att.data || [] });
        }
        case "admin_planning_enregistrer": {
          const motif = motifOk(b.motif);
          const corps = {
            portee: b.portee === "suivantes" ? "suivantes" : "semaine", motif,
            nouveaux: Array.isArray(b.nouveaux) ? b.nouveaux.slice(0, 30) : [],
            postes: Array.isArray(b.postes) ? b.postes.slice(0, 200) : [],
            cellules: Array.isArray(b.cellules) ? b.cellules.slice(0, 500) : [],
          };
          if (!corps.nouveaux.length && !corps.postes.length && !corps.cellules.length) throw new Refus("Aucune modification à enregistrer.");
          const { data, error } = await sb.rpc("hr_planning_appliquer", { p: corps, p_auteur: AUTEUR_GERANT });
          if (error) {
            const m = String(error.message || "");
            if (m.includes("REFUS:")) throw new Refus(m.slice(m.indexOf("REFUS:") + 6));
            if (/invalid input syntax for type time|date\/time field value out of range/i.test(m)) throw new Refus("Une heure saisie est invalide.");
            throw error;
          }
          await pousser();
          return json({ ok: true, ...(data as Record<string, unknown>) });
        }

        // --- paramètres ---
        case "admin_parametres":
          return json({ ok: true, parametres: await parametres(), modifiables: Object.keys(PARAMS_MODIFIABLES) });
        case "admin_parametre_modifier": {
          const motif = motifOk(b.motif);
          const cle = String(b.cle || ""), valeur = String(b.valeur ?? "").trim();
          const ok = PARAMS_MODIFIABLES[cle];
          if (!ok) throw new Refus("Paramètre non modifiable.");
          if (!ok(valeur)) throw new Refus("Valeur invalide pour ce paramètre.");
          const avant = (await parametres())[cle] ?? null;
          const { error } = await sb.from("hr_parametres").upsert({ cle, valeur }, { onConflict: "cle" });
          if (error) throw error;
          await journal("parametre", cle, "modification", { valeur: avant }, { valeur }, motif);
          return json({ ok: true });
        }

        // --- absences et congés ---
        case "admin_demandes":
        case "admin_absences": {
          // filtre : attente | complement | acceptees | refusees | justificatif_manquant | toutes
          const filtre = String(b.filtre || (b.statut ? "" : "toutes"));
          let q = sb.from("hr_absences").select(SELECT_DEMANDE + ", hr_employes(nom, service)").order("created_at", { ascending: false }).limit(300);
          const parFiltre: Record<string, string> = { attente: "demandee", complement: "complement", acceptees: "validee", refusees: "refusee", annulees: "annulee" };
          if (parFiltre[filtre]) q = q.eq("statut", parFiltre[filtre]);
          else if (b.statut) q = q.eq("statut", String(b.statut));
          if (b.employe_id) q = q.eq("employe_id", Number(b.employe_id));
          if (dateValide(b.debut)) q = q.gte("date_fin", b.debut);
          if (dateValide(b.fin)) q = q.lte("date_debut", b.fin);
          const { data, error } = await q;
          if (error) throw error;
          let demandes = (data || []).map(avecManquant);
          // deno-lint-ignore no-explicit-any
          if (b.service) demandes = demandes.filter((d: any) => d.hr_employes?.service === String(b.service));
          // deno-lint-ignore no-explicit-any
          if (filtre === "justificatif_manquant") demandes = demandes.filter((d: any) => d.justificatif_manquant && ["demandee", "complement", "validee"].includes(d.statut));
          // deno-lint-ignore no-explicit-any
          const compte = (s: string) => (data || []).filter((d: any) => d.statut === s).length;
          return json({
            ok: true, demandes, absences: demandes,
            compteurs: {
              attente: compte("demandee"), complement: compte("complement"), acceptees: compte("validee"), refusees: compte("refusee"),
              // deno-lint-ignore no-explicit-any
              justificatif_manquant: (data || []).map(avecManquant).filter((d: any) => d.justificatif_manquant && ["demandee", "complement", "validee"].includes(d.statut)).length,
            },
          });
        }
        case "admin_demande": {
          // fiche complète : demande, employé, statistiques du mois, historique des modifications
          const { data: dd, error } = await sb.from("hr_absences").select(SELECT_DEMANDE + ", hr_employes(id, nom, service)").eq("id", Number(b.id)).maybeSingle();
          if (error) throw error;
          // deno-lint-ignore no-explicit-any
          const d = dd as any;
          if (!d) throw new Refus("Demande introuvable.", 404);
          const rows = (await journees(debutMois(js), js)).filter((r) => r.employe_id === d.employe_id);
          const { data: hist } = await sb.from("hr_journal").select("quand, auteur, action, ancienne, nouvelle, motif").eq("objet", "absence").eq("objet_id", String(d.id)).order("quand");
          return json({ ok: true, demande: avecManquant(d), mois: emojiMois(rows, await configEmojis()), historique: hist || [] });
        }
        case "admin_justificatif": {
          const { data: j } = await sb.from("hr_justificatifs").select("id, absence_id, chemin, type_mime").eq("id", Number(b.id)).maybeSingle();
          if (!j) throw new Refus("Document introuvable.", 404);
          const fichier = await lireJustificatif(j.chemin);
          await journal("justificatif", j.id, "consultation", null, { absence_id: j.absence_id }, "Consultation du justificatif");
          return json({ ok: true, type_mime: j.type_mime, fichier });
        }
        case "admin_demande_decider":
        case "admin_absence_decider": {
          // validee = ACCEPTER, refusee = REFUSER, complement = demander des informations, annulee = annuler une décision
          const decision = String(b.decision || "");
          if (!["validee", "refusee", "complement", "annulee"].includes(decision)) throw new Refus("Décision invalide.");
          const commentaire = champ(b.commentaire ?? b.motif, 500);
          if (decision !== "validee" && (!commentaire || commentaire.length < 3)) throw new Refus("Un commentaire est obligatoire pour refuser, annuler ou demander un complément.");
          const { data: old } = await sb.from("hr_absences").select("*, hr_employes(nom)").eq("id", Number(b.id)).maybeSingle();
          if (!old) throw new Refus("Demande introuvable.", 404);
          if (old.statut === decision) throw new Refus("Cette demande a déjà ce statut.", 409);
          if (old.statut === "annulee") throw new Refus("Cette demande est annulée.", 409);
          const maj: Record<string, unknown> = { statut: decision, commentaire_decision: commentaire, decide_par: AUTEUR_GERANT, decide_le: new Date().toISOString(), maj_le: new Date().toISOString() };
          if (decision === "complement" && b.justificatif_requis) maj.justificatif_requis = true;
          const { error } = await sb.from("hr_absences").update(maj).eq("id", old.id);
          if (error) throw error;
          const jid = await journal("absence", old.id, "decision", { statut: old.statut, commentaire_decision: old.commentaire_decision }, { statut: decision, commentaire_decision: commentaire }, commentaire || "Demande acceptée");
          const lib = `Votre demande (${LIBELLE_TYPE[old.type].toLowerCase()}) ${periodeFr(old.date_debut, old.date_fin)}`;
          const msg: Record<string, [string, string, string]> = {
            validee: ["acceptee", "Votre demande a été acceptée", `${lib} a été validée par votre responsable.${commentaire ? ` Commentaire : ${commentaire}` : ""}`],
            refusee: ["refusee", "Votre demande a été refusée", `${lib} a été refusée. Motif : ${commentaire}`],
            complement: [b.justificatif_requis ? "justificatif_manquant" : "complement", "Information demandée", `${lib} nécessite un complément : ${commentaire}`],
            annulee: ["annulee", "Demande annulée", `${lib} a été annulée. Motif : ${commentaire}`],
          };
          await notifier(`employe:${old.employe_id}`, msg[decision][0], old.id, msg[decision][2],
            { titre: msg[decision][1], lien: "demandes", cle: `journal:${jid}`, details: { decision, date_debut: old.date_debut, date_fin: old.date_fin, motif: commentaire } });
          await pousser();
          return json({ ok: true });
        }
        case "admin_demande_creer":
        case "admin_absence_creer": {
          // saisie directe par le responsable (déjà acceptée)
          const motif = motifOk(b.motif);
          const type = String(b.type || "");
          if (!TYPES_ABSENCE.includes(type)) throw new Refus("Type d'absence invalide.");
          const debut = b.date_debut || b.date, fin = b.date_fin || debut;
          if (!dateValide(debut) || !dateValide(fin) || fin < debut) throw new Refus("Dates invalides.");
          const { data, error } = await sb.from("hr_absences").insert({
            employe_id: Number(b.employe_id), type, date_debut: debut, date_fin: fin,
            heure_debut: heureOuNull(b.heure_debut), heure_fin: heureOuNull(b.heure_fin),
            motif, explication: champ(b.explication ?? b.commentaire, 1000), demande_par: "gerant",
            statut: "validee", decide_par: AUTEUR_GERANT, decide_le: new Date().toISOString(),
          }).select("id").single();
          if (error) throw error;
          if (b.fichier) await enregistrerJustificatif(data.id, Number(b.employe_id), b.fichier, b.nom_fichier, "gerant");
          await journal("absence", data.id, "ajout", null, { employe_id: Number(b.employe_id), type, date_debut: debut, date_fin: fin, statut: "validee" }, motif);
          await notifier(`employe:${Number(b.employe_id)}`, "acceptee", data.id, `${LIBELLE_TYPE[type]} enregistrée par votre responsable ${periodeFr(debut, fin)}.`,
            { titre: "Absence enregistrée", lien: "demandes", cle: `absence:${data.id}` });
          await pousser();
          return json({ ok: true, id: data.id });
        }
        case "admin_calendrier": {
          // absences et congés acceptés sur la période, filtrables par employé et par service
          const debut = dateValide(b.debut) ? b.debut : debutMois(js);
          const fin = dateValide(b.fin) ? b.fin : plusJours(debut, 30);
          let q = sb.from("hr_absences").select("id, employe_id, type, date_debut, date_fin, heure_debut, heure_fin, motif, statut, hr_employes(nom, service)")
            .in("statut", b.inclure_attente ? ["validee", "demandee", "complement"] : ["validee"])
            .lte("date_debut", fin).gte("date_fin", debut).order("date_debut");
          if (b.employe_id) q = q.eq("employe_id", Number(b.employe_id));
          const { data, error } = await q;
          if (error) throw error;
          // deno-lint-ignore no-explicit-any
          const evts = (data || []).filter((d: any) => !b.service || d.hr_employes?.service === String(b.service));
          return json({ ok: true, debut, fin, evenements: evts });
        }
        case "admin_notifications": {
          const { data } = await sb.from("hr_notifications").select(CHAMPS_NOTIF)
            .eq("destinataire", "gerant").order("created_at", { ascending: false }).limit(100);
          if (b.marquer_lues) await sb.from("hr_notifications").update({ lu: true, lu_le: new Date().toISOString() }).eq("destinataire", "gerant").eq("lu", false);
          const { count } = await sb.from("hr_notifications").select("id", { count: "exact", head: true }).eq("destinataire", "gerant").eq("lu", false);
          return json({ ok: true, notifications: data || [], non_lues: count || 0, vapid: (await vapid())?.publicKey || null });
        }
        case "admin_notification_lue": {
          await sb.from("hr_notifications").update({ lu: true, lu_le: new Date().toISOString() }).eq("id", Number(b.id)).eq("destinataire", "gerant").eq("lu", false);
          return json({ ok: true });
        }
        case "admin_push_abonner": {
          await abonner("gerant", null, b.abonnement, req.headers.get("user-agent"));
          await notifier("gerant", "push_active", null, "Tu recevras ici les nouvelles demandes du personnel.", { titre: "Notifications activées" });
          await pousser();
          return json({ ok: true });
        }

        // --- journal ---
        case "admin_journal": {
          let q = sb.from("hr_journal").select("*").order("quand", { ascending: false }).limit(Math.min(Number(b.limite) || 100, 500));
          if (b.objet) q = q.eq("objet", String(b.objet));
          const { data, error } = await q;
          if (error) throw error;
          return json({ ok: true, journal: data || [] });
        }
      }
    }
    return json({ erreur: "Action inconnue" }, 400);
  } catch (e) {
    if (e instanceof Refus) return json({ erreur: e.message }, e.status);
    console.error(e);
    return json({ erreur: "Erreur serveur, réessaie." }, 500);
  }
});
