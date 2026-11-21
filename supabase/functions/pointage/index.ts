// CAPANNA SMART HR – fonction de pointage (v2)
// Toutes les données passent par ici (clé service). Le pointage n'est accepté
// que depuis le réseau du restaurant (adresse IP enregistrée par le gérant)
// et depuis le téléphone lié à l'employé.
// v2 : moteur de calcul hr_journees (SQL), tableau de bord, fiches, corrections
// avec motif + journal, absences et congés, planning en créneaux, paramètres.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const TZ = "Africa/Casablanca";
const BASCULE_H = 5; // avant 05h00, on est encore sur la journée de la veille
const JOURS = ["", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const TYPES_ABS = ["conge", "maladie", "absence_autorisee", "absence_injustifiee", "retard_justifie"];
const AUTEUR = "Gérant";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class Refus extends Error { constructor(m: string, public code = 400) { super(m); } }

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
function addDays(dateStr: string, n: number) {
  return new Date(new Date(dateStr + "T12:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
}
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
const hhmm = (m: number | null) => m === null ? "" : `${String(Math.floor(m / 60) % 24).padStart(2, "0")}h${String(m % 60).padStart(2, "0")}`;
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s: unknown) => typeof s === "string" && /^\d{1,2}:\d{2}$/.test(s);

// Convertit une date de service + heure locale (HH:MM, après minuit = lendemain) en instant UTC.
function instantLocal(js: string, hm: string) {
  const [h, m] = hm.split(":").map(Number);
  const jour = h < BASCULE_H ? addDays(js, 1) : js;
  // Casablanca : on cherche l'offset réel à cette date
  const guess = new Date(`${jour}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const l = local(guess);
  const diffMin = (l.h * 60 + l.m) - (h * 60 + m) + (l.date === jour ? 0 : (l.date > jour ? 1440 : -1440));
  return new Date(guess.getTime() - diffMin * 60e3);
}

async function planningDu(employeId: number, js: string) {
  const { data } = await sb.from("hr_creneaux").select("ordre, debut, fin, pause_min")
    .eq("employe_id", employeId).eq("jour", dow(js)).eq("actif", true).order("ordre");
  return data || [];
}
const texteCreneaux = (cs: { debut: string; fin: string }[]) =>
  cs.length ? cs.map((c) => `${hhmm(tMin(c.debut))}–${hhmm(tMin(c.fin))}`).join(" + ") : "OFF";

// ---------- paramètres ----------
async function parametres() {
  const { data } = await sb.from("hr_parametres").select("cle, valeur");
  const p = Object.fromEntries((data || []).filter((x) => !x.cle.startsWith("admin_")).map((x) => [x.cle, x.valeur]));
  return p as Record<string, string>;
}
const PARAMS_MODIFIABLES: Record<string, (v: string) => boolean> = {
  tolerance_retard_min: (v) => /^\d{1,3}$/.test(v),
  seuil_heures_sup_min: (v) => /^\d{1,3}$/.test(v),
  alerte_cumul_1_min: (v) => /^\d{1,4}$/.test(v),
  alerte_cumul_2_min: (v) => /^\d{1,4}$/.test(v),
  mode_retard: (v) => ["complet", "deduit"].includes(v),
  mode_heures_sup: (v) => ["complet", "deduit"].includes(v),
  debut_suivi: (v) => isDate(v),
};

// ---------- journal ----------
async function journal(objet: string, objet_id: string | number | null, action: string, ancienne: unknown, nouvelle: unknown, motif: string) {
  const { error } = await sb.from("hr_journal").insert({
    auteur: AUTEUR, objet, objet_id: objet_id === null ? null : String(objet_id), action, ancienne, nouvelle, motif,
  });
  if (error) throw error;
}
function exigerMotif(m: unknown) {
  const s = String(m || "").trim();
  if (s.length < 3) throw new Refus("Le motif est obligatoire.");
  return s;
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

// ---------- gérant : authentification ----------
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

// ---------- moteur ----------
type Ligne = {
  jour: string; employe_id: number; nom: string; service: string; creneau_ordre: number;
  prevu_debut: string | null; prevu_fin: string | null; pause_min: number;
  arrivee_min: number | null; depart_min: number | null;
  retard_min: number; retard_justifie_min: number; heures_sup_min: number; depart_anticipe_min: number;
  presence_min: number | null; travail_min: number | null; statut: string; absence_type: string | null;
};
async function journees(debut: string, fin: string): Promise<Ligne[]> {
  const { data, error } = await sb.rpc("hr_journees", { p_debut: debut, p_fin: fin });
  if (error) throw error;
  return (data || []) as Ligne[];
}

type Stats = {
  retard_total_min: number; nb_retards: number; retard_moyen_min: number; ponctualite_pct: number | null;
  jours_travailles: number; creneaux_travailles: number; absences_injustifiees: number; absences_justifiees: number;
  heures_sup_min: number; travail_min: number; departs_non_pointes: number; hors_planning: number; departs_anticipes: number;
};
function stats(ls: Ligne[]): Stats {
  const trav = ls.filter((l) => l.arrivee_min !== null && l.statut !== "hors_planning");
  const nbRet = trav.filter((l) => l.retard_min > 0).length;
  const retTot = ls.reduce((s, l) => s + (l.retard_min || 0), 0);
  return {
    retard_total_min: retTot,
    nb_retards: nbRet,
    retard_moyen_min: nbRet ? Math.round(retTot / nbRet) : 0,
    ponctualite_pct: trav.length ? Math.round(1000 * (trav.length - nbRet) / trav.length) / 10 : null,
    jours_travailles: new Set(ls.filter((l) => l.arrivee_min !== null).map((l) => l.jour)).size,
    creneaux_travailles: trav.length,
    absences_injustifiees: ls.filter((l) => l.statut === "absence_injustifiee").length,
    absences_justifiees: ls.filter((l) => l.statut === "absence_justifiee").length,
    heures_sup_min: ls.reduce((s, l) => s + (l.heures_sup_min || 0), 0),
    travail_min: ls.reduce((s, l) => s + (l.travail_min || 0), 0),
    departs_non_pointes: ls.filter((l) => l.statut === "depart_non_pointe").length,
    hors_planning: ls.filter((l) => l.statut === "hors_planning").length,
    departs_anticipes: ls.filter((l) => l.depart_anticipe_min > 0).length,
  };
}
function lundiDe(js: string) { return addDays(js, 1 - dow(js)); }

// Bornes de suivi : on ne compte jamais avant debut_suivi.
async function bornes(debut?: string, fin?: string) {
  const p = await parametres();
  const auj = jourService(new Date());
  const ds = p.debut_suivi || "2000-01-01";
  let d = isDate(debut) ? debut! : addDays(auj, -29);
  let f = isDate(fin) ? fin! : auj;
  if (d < ds) d = ds;
  if (f > auj) f = auj;
  if (f < d) f = d;
  return { debut: d, fin: f, auj, debut_suivi: ds, p };
}

async function alertes(p: Record<string, string>, auj: string, ds: string) {
  const debMois = auj.slice(0, 8) + "01";
  const d0 = debMois < ds ? ds : debMois;
  const out: { niveau: string; type: string; nom?: string; texte: string; jour?: string }[] = [];
  if (auj < ds) return out;
  const ls = await journees(d0 < addDays(auj, -6) ? d0 : addDays(auj, -6) < ds ? ds : addDays(auj, -6), auj);
  const s1 = +(p.alerte_cumul_1_min || 60), s2 = +(p.alerte_cumul_2_min || 180);
  // retards du jour
  for (const l of ls.filter((x) => x.jour === auj && x.retard_min > 0)) {
    out.push({ niveau: "orange", type: "retard", nom: l.nom, jour: l.jour, texte: `Retard de ${l.retard_min} min (prévu ${hhmm(tMin(l.prevu_debut))})` });
  }
  for (const l of ls.filter((x) => x.jour === auj && x.statut === "absent_en_cours")) {
    out.push({ niveau: "orange", type: "absent", nom: l.nom, jour: l.jour, texte: `Pas encore arrivé (prévu ${hhmm(tMin(l.prevu_debut))})` });
  }
  // cumuls du mois
  const mois = ls.filter((x) => x.jour >= d0);
  const parEmp = new Map<string, number>();
  for (const l of mois) parEmp.set(l.nom, (parEmp.get(l.nom) || 0) + l.retard_min);
  for (const [nom, m] of parEmp) {
    if (m > s2) out.push({ niveau: "rouge", type: "cumul", nom, texte: `Retard cumulé du mois : ${hhmm(m).replace(/^0/, "")} (seuil ${s2 / 60} h dépassé)` });
    else if (m > s1) out.push({ niveau: "orange", type: "cumul", nom, texte: `Retard cumulé du mois : ${hhmm(m).replace(/^0/, "")} (seuil ${s1 / 60} h dépassé)` });
  }
  // 7 derniers jours
  for (const l of ls.filter((x) => x.jour < auj && x.jour >= addDays(auj, -6))) {
    if (l.statut === "absence_injustifiee") out.push({ niveau: "rouge", type: "absence", nom: l.nom, jour: l.jour, texte: `Absence injustifiée` });
    if (l.statut === "depart_non_pointe") out.push({ niveau: "orange", type: "depart", nom: l.nom, jour: l.jour, texte: `Départ non pointé` });
    if (l.statut === "hors_planning") out.push({ niveau: "orange", type: "inhabituel", nom: l.nom, jour: l.jour, texte: `Pointage un jour sans service prévu` });
    if (l.arrivee_min !== null && l.prevu_debut && tMin(l.prevu_debut)! - l.arrivee_min > 90) {
      out.push({ niveau: "orange", type: "inhabituel", nom: l.nom, jour: l.jour, texte: `Arrivée inhabituelle à ${hhmm(l.arrivee_min)} (prévu ${hhmm(tMin(l.prevu_debut))})` });
    }
  }
  // fraude possible : tentatives hors Wi-Fi, réactivations de téléphone
  const { data: refus } = await sb.from("hr_pointages").select("employe_id, horodatage, jour_service, motif, hr_employes(nom)")
    .eq("accepte", false).gte("jour_service", addDays(auj, -6) < ds ? ds : addDays(auj, -6)).order("horodatage", { ascending: false });
  // deno-lint-ignore no-explicit-any
  for (const r of (refus || []) as any[]) {
    const l = local(new Date(r.horodatage));
    out.push({ niveau: "rouge", type: "fraude", nom: r.hr_employes?.nom, jour: r.jour_service, texte: `Tentative de pointage hors Wi-Fi Capanna à ${String(l.h).padStart(2, "0")}h${String(l.m).padStart(2, "0")}` });
  }
  const { data: rev } = await sb.from("hr_appareils").select("employe_id, revoque_le, hr_employes(nom)")
    .not("revoque_le", "is", null).gte("revoque_le", new Date(Date.now() - 7 * 864e5).toISOString());
  // deno-lint-ignore no-explicit-any
  for (const r of (rev || []) as any[]) {
    out.push({ niveau: "info", type: "appareil", nom: r.hr_employes?.nom, texte: `Téléphone réinitialisé le ${local(new Date(r.revoque_le)).date.split("-").reverse().join("/")}` });
  }
  const ordre: Record<string, number> = { rouge: 0, orange: 1, info: 2 };
  return out.sort((a, b) => ordre[a.niveau] - ordre[b.niveau]);
}

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
      // ===================== EMPLOYÉ =====================
      case "init": {
        const a = await appareil(b.token);
        let moi = null;
        if (a) {
          const cs = await planningDu(a.employe.id, js);
          const { data: dem } = await sb.from("hr_absences").select("id, type, date_debut, date_fin, statut, commentaire")
            .eq("employe_id", a.employe.id).order("created_at", { ascending: false }).limit(5);
          moi = { nom: a.employe.nom, service: a.employe.service, prevu: texteCreneaux(cs), aujourdhui: await etatDuJour(a.employe.id, js), demandes: dem || [] };
        }
        let employes: unknown[] = [];
        if (!a && wifi) {
          const { data } = await sb.from("hr_employes").select("id, nom, service").eq("actif", true).order("service").order("nom");
          employes = data || [];
        }
        return json({ wifi, moi, employes, jour_service: js, jour_nom: JOURS[dow(js)] });
      }

      case "enregistrer": {
        if (!wifi) return json({ erreur: "Connecte-toi au Wi-Fi Capanna pour activer ton téléphone. Si tu es déjà dessus, coupe tes données mobiles et réessaie." }, 403);
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
          return json({ erreur: "Pointage refusé : tu n'es pas sur le Wi-Fi Capanna. Si tu es déjà connecté au Wi-Fi, coupe tes données mobiles et réessaie." }, 403);
        }
        const jour = await etatDuJour(a.employe.id, js);
        const dernier = jour[jour.length - 1];
        if (type === "arrivee" && dernier?.type === "arrivee") return json({ erreur: "Ton arrivée est déjà pointée." }, 409);
        if (type === "depart" && dernier?.type !== "arrivee") return json({ erreur: "Pointe d'abord ton arrivée." }, 409);
        const { error } = await sb.from("hr_pointages").insert({ employe_id: a.employe.id, type, horodatage: now.toISOString(), jour_service: js, ip, appareil_id: a.appareilId, accepte: true });
        if (error) throw error;
        const p = await parametres();
        const tol = +(p.tolerance_retard_min || 5);
        const cs = await planningDu(a.employe.id, js);
        const m = minutesService(now);
        let info = "";
        if (!cs.length) info = "Attention : aucun service prévu pour toi aujourd'hui au planning.";
        else if (type === "arrivee") {
          const c = cs.reduce((best, x) => Math.abs(m - tMin(x.debut)!) < Math.abs(m - tMin(best.debut)!) ? x : best);
          const r = m - tMin(c.debut)!;
          info = r > tol ? `Retard de ${r} min (prévu ${hhmm(tMin(c.debut))}).` : "À l'heure. Bon service !";
        } else {
          const c = cs.reduce((best, x) => Math.abs(m - finMin(x.debut, x.fin)!) < Math.abs(m - finMin(best.debut, best.fin)!) ? x : best);
          const f = finMin(c.debut, c.fin)!;
          info = f - m > 5 ? `Départ ${f - m} min avant l'heure prévue (${hhmm(f)}).` : "Merci, bonne fin de service !";
        }
        const l = local(now);
        return json({ ok: true, type, heure: `${String(l.h).padStart(2, "0")}h${String(l.m).padStart(2, "0")}`, info, aujourdhui: await etatDuJour(a.employe.id, js) });
      }

      case "demander_absence": {
        const a = await appareil(b.token);
        if (!a) return json({ erreur: "Téléphone non reconnu. Demande au gérant." }, 403);
        if (!["conge", "maladie", "absence_autorisee", "retard_justifie"].includes(b.type)) throw new Refus("Type de demande invalide.");
        if (!isDate(b.date_debut) || !isDate(b.date_fin) || b.date_fin < b.date_debut) throw new Refus("Dates invalides.");
        const { error } = await sb.from("hr_absences").insert({
          employe_id: a.employe.id, type: b.type, date_debut: b.date_debut, date_fin: b.date_fin,
          commentaire: String(b.commentaire || "").slice(0, 500), demande_par: "employe", statut: "demandee",
        });
        if (error) throw error;
        return json({ ok: true });
      }

      // ===================== GÉRANT (sans code) =====================
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

    if (!String(b.action || "").startsWith("admin_")) return json({ erreur: "Action inconnue" }, 400);
    if (!(await adminOk(b.code))) return json({ erreur: "Code gérant incorrect." }, 403);

    // ===================== GÉRANT (avec code) =====================
    switch (b.action) {
      case "admin_connexion": {
        const { data: res } = await sb.from("hr_reseaux").select("reseau, libelle, created_at").order("id");
        return json({ ok: true, wifi, ip_vue: reseauDe(ip), reseaux: res || [] });
      }
      case "admin_ajouter_wifi": {
        const r = reseauDe(ip);
        if (!r) throw new Refus("Adresse introuvable.");
        await sb.from("hr_reseaux").upsert({ reseau: r, libelle: b.libelle || "Wi-Fi Capanna" }, { onConflict: "reseau" });
        await journal("reseau", r, "ajout", null, { reseau: r }, "Réseau enregistré depuis l'espace gérant");
        return json({ ok: true, reseau: r });
      }
      case "admin_retirer_wifi": {
        await sb.from("hr_reseaux").delete().eq("reseau", b.reseau);
        await journal("reseau", b.reseau, "annulation", { reseau: b.reseau }, null, "Réseau retiré depuis l'espace gérant");
        return json({ ok: true });
      }
      case "admin_equipe": {
        const { data: emps } = await sb.from("hr_employes").select("id, nom, service, pin, actif").order("service").order("nom");
        const { data: apps } = await sb.from("hr_appareils").select("employe_id").eq("actif", true);
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
        await sb.from("hr_appareils").update({ actif: false, revoque_le: new Date().toISOString() }).eq("employe_id", Number(b.employe_id)).eq("actif", true);
        await journal("appareil", b.employe_id, "annulation", { actif: true }, { actif: false }, "Téléphone réinitialisé par le gérant");
        return json({ ok: true });
      }
      case "admin_nouveau_code": {
        const pin = String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
        await sb.from("hr_employes").update({ pin }).eq("id", Number(b.employe_id));
        await journal("employe", b.employe_id, "modification", null, { pin: "nouveau code" }, "Nouveau code d'activation généré");
        return json({ ok: true, pin });
      }

      // ----- tableau de bord -----
      case "admin_tableau": {
        const { debut, fin, auj, debut_suivi, p } = await bornes(b.debut, b.fin);
        let ls = await journees(debut, fin);
        if (b.service) ls = ls.filter((l) => l.service === b.service);
        if (b.employe_id) ls = ls.filter((l) => l.employe_id === Number(b.employe_id));
        // aujourd'hui (toujours calculé, même avant le début du suivi)
        const lj = (await journees(auj, auj)).filter((l) => (!b.service || l.service === b.service));
        const presents = [...new Set(lj.filter((l) => l.statut === "present").map((l) => l.nom))];
        const absents = [...new Set(lj.filter((l) => l.statut === "absent_en_cours").map((l) => l.nom))];
        const retardsJour = lj.filter((l) => l.retard_min > 0).map((l) => ({ nom: l.nom, retard_min: l.retard_min }));
        const prevusJour = [...new Set(lj.filter((l) => l.statut !== "hors_planning").map((l) => l.nom))].length;
        // classements
        const parEmp = new Map<number, Ligne[]>();
        for (const l of ls) { if (!parEmp.has(l.employe_id)) parEmp.set(l.employe_id, []); parEmp.get(l.employe_id)!.push(l); }
        const classement = [...parEmp.values()].map((x) => ({ employe_id: x[0].employe_id, nom: x[0].nom, service: x[0].service, ...stats(x) }));
        // séries par semaine et par mois
        const serie = (cle: (l: Ligne) => string) => {
          const m = new Map<string, Ligne[]>();
          for (const l of ls) { const k = cle(l); if (!m.has(k)) m.set(k, []); m.get(k)!.push(l); }
          return [...m.entries()].sort().map(([k, x]) => ({ periode: k, ...stats(x) }));
        };
        return json({
          ok: true, debut, fin, aujourdhui: auj, debut_suivi, parametres: p,
          jour: { presents, absents, retards: retardsJour, prevus: prevusJour },
          equipe: stats(ls), classement,
          semaines: serie((l) => lundiDe(l.jour)), mois: serie((l) => l.jour.slice(0, 7)),
          alertes: await alertes(p, auj, debut_suivi),
        });
      }

      // ----- fiche individuelle -----
      case "admin_fiche": {
        const id = Number(b.employe_id);
        const { data: e } = await sb.from("hr_employes").select("id, nom, service, actif").eq("id", id).maybeSingle();
        if (!e) throw new Refus("Employé introuvable.", 404);
        const { debut_suivi, auj } = await bornes();
        const depuis = auj < debut_suivi ? auj : debut_suivi;
        const ls = (await journees(depuis, auj)).filter((l) => l.employe_id === id);
        const suivi = ls.filter((l) => l.jour >= debut_suivi);
        const lundi = lundiDe(auj), mois1 = auj.slice(0, 8) + "01";
        const { data: abs } = await sb.from("hr_absences").select("*").eq("employe_id", id).order("date_debut", { ascending: false }).limit(50);
        const { data: cr } = await sb.from("hr_creneaux").select("id, jour, ordre, debut, fin, pause_min").eq("employe_id", id).eq("actif", true).order("jour").order("ordre");
        return json({
          ok: true, employe: e, aujourdhui: auj, debut_suivi,
          retard_jour_min: ls.filter((l) => l.jour === auj).reduce((s, l) => s + l.retard_min, 0),
          semaine: stats(suivi.filter((l) => l.jour >= lundi)),
          mois: stats(suivi.filter((l) => l.jour >= mois1)),
          total: stats(suivi),
          historique: ls.slice().reverse(),
          absences: abs || [], creneaux: cr || [],
        });
      }

      // ----- pointages bruts et corrections -----
      case "admin_pointages": {
        const id = Number(b.employe_id);
        const d = isDate(b.debut) ? b.debut : addDays(js, -6), f = isDate(b.fin) ? b.fin : js;
        const { data } = await sb.from("hr_pointages").select("id, type, horodatage, jour_service, accepte, annule, source, motif, remplace_id")
          .eq("employe_id", id).gte("jour_service", d).lte("jour_service", f).order("horodatage", { ascending: false });
        return json({ ok: true, pointages: (data || []).map((x) => ({ ...x, heure: hhmm(minutesService(new Date(x.horodatage))) })) });
      }
      case "admin_corriger": {
        const motif = exigerMotif(b.motif);
        const id = Number(b.employe_id);
        if (b.op === "ajouter") {
          if (!isDate(b.jour) || !isTime(b.heure)) throw new Refus("Date ou heure invalide.");
          const type = b.type === "depart" ? "depart" : "arrivee";
          const h = instantLocal(b.jour, b.heure);
          const { data, error } = await sb.from("hr_pointages").insert({ employe_id: id, type, horodatage: h.toISOString(), jour_service: b.jour, accepte: true, source: "manuel", motif }).select("id").single();
          if (error) throw error;
          await journal("pointage", data.id, "ajout", null, { employe_id: id, type, jour: b.jour, heure: b.heure }, motif);
          return json({ ok: true });
        }
        const pid = Number(b.pointage_id);
        const { data: old } = await sb.from("hr_pointages").select("*").eq("id", pid).eq("employe_id", id).maybeSingle();
        if (!old) throw new Refus("Pointage introuvable.", 404);
        if (old.annule) throw new Refus("Ce pointage est déjà annulé.");
        const ancienne = { type: old.type, jour: old.jour_service, heure: hhmm(minutesService(new Date(old.horodatage))), source: old.source };
        if (b.op === "annuler") {
          await sb.from("hr_pointages").update({ annule: true }).eq("id", pid);
          await journal("pointage", pid, "annulation", ancienne, { annule: true }, motif);
          return json({ ok: true });
        }
        if (b.op === "modifier") {
          if (!isTime(b.heure)) throw new Refus("Heure invalide.");
          const h = instantLocal(old.jour_service, b.heure);
          const type = b.type === "depart" || b.type === "arrivee" ? b.type : old.type;
          const { data: nv, error } = await sb.from("hr_pointages").insert({ employe_id: id, type, horodatage: h.toISOString(), jour_service: old.jour_service, accepte: true, source: "manuel", motif, remplace_id: pid }).select("id").single();
          if (error) throw error;
          await sb.from("hr_pointages").update({ annule: true }).eq("id", pid);
          await journal("pointage", pid, "modification", ancienne, { type, jour: old.jour_service, heure: b.heure, nouveau_id: nv.id }, motif);
          return json({ ok: true });
        }
        throw new Refus("Opération inconnue.");
      }

      // ----- absences et congés -----
      case "admin_absences": {
        let q = sb.from("hr_absences").select("*, hr_employes(nom, service)").order("created_at", { ascending: false }).limit(200);
        if (b.statut) q = q.eq("statut", b.statut);
        const { data } = await q;
        return json({ ok: true, absences: data || [] });
      }
      case "admin_absence_creer": {
        const motif = exigerMotif(b.motif);
        if (!TYPES_ABS.includes(b.type)) throw new Refus("Type invalide.");
        if (!isDate(b.date_debut) || !isDate(b.date_fin) || b.date_fin < b.date_debut) throw new Refus("Dates invalides.");
        const row = { employe_id: Number(b.employe_id), type: b.type, date_debut: b.date_debut, date_fin: b.date_fin, commentaire: motif, demande_par: "gerant", statut: "validee", decide_par: AUTEUR, decide_le: new Date().toISOString() };
        const { data, error } = await sb.from("hr_absences").insert(row).select("id").single();
        if (error) throw error;
        await journal("absence", data.id, "ajout", null, row, motif);
        return json({ ok: true });
      }
      case "admin_absence_decider": {
        const motif = String(b.motif || "").trim() || (b.decision === "validee" ? "Demande validée" : "Demande refusée");
        if (!["validee", "refusee", "annulee"].includes(b.decision)) throw new Refus("Décision invalide.");
        if (b.decision === "annulee") exigerMotif(b.motif);
        const { data: old } = await sb.from("hr_absences").select("*").eq("id", Number(b.absence_id)).maybeSingle();
        if (!old) throw new Refus("Demande introuvable.", 404);
        await sb.from("hr_absences").update({ statut: b.decision, decide_par: AUTEUR, decide_le: new Date().toISOString() }).eq("id", old.id);
        await journal("absence", old.id, "modification", { statut: old.statut }, { statut: b.decision }, motif);
        return json({ ok: true });
      }

      // ----- planning (créneaux) -----
      case "admin_creneaux": {
        const { data } = await sb.from("hr_creneaux").select("id, employe_id, jour, ordre, debut, fin, pause_min").eq("actif", true).order("employe_id").order("jour").order("ordre");
        return json({ ok: true, creneaux: data || [] });
      }
      case "admin_creneaux_jour": {
        // remplace les créneaux d'un employé pour un jour (0, 1 ou 2 créneaux)
        const motif = exigerMotif(b.motif);
        const id = Number(b.employe_id), jour = Number(b.jour);
        if (!(jour >= 1 && jour <= 7)) throw new Refus("Jour invalide.");
        const liste = (Array.isArray(b.creneaux) ? b.creneaux : []).slice(0, 3);
        for (const c of liste) if (!isTime(c.debut) || !isTime(c.fin) || !(Number(c.pause_min) >= 0)) throw new Refus("Horaire invalide.");
        const { data: avant } = await sb.from("hr_creneaux").select("ordre, debut, fin, pause_min").eq("employe_id", id).eq("jour", jour).eq("actif", true).order("ordre");
        await sb.from("hr_creneaux").update({ actif: false }).eq("employe_id", id).eq("jour", jour).eq("actif", true);
        // ordre unique par (employé, jour, ordre) : on réutilise les lignes existantes si besoin
        for (let i = 0; i < liste.length; i++) {
          const c = liste[i];
          const { error } = await sb.from("hr_creneaux").upsert({ employe_id: id, jour, ordre: i + 1, debut: c.debut, fin: c.fin, pause_min: Number(c.pause_min) || 0, actif: true }, { onConflict: "employe_id,jour,ordre" });
          if (error) throw error;
        }
        await journal("creneau", `${id}/${JOURS[jour]}`, "modification", avant, liste, motif);
        return json({ ok: true });
      }

      // ----- paramètres et journal -----
      case "admin_parametres": {
        return json({ ok: true, parametres: await parametres() });
      }
      case "admin_parametre_modifier": {
        const motif = exigerMotif(b.motif);
        const ok = PARAMS_MODIFIABLES[b.cle];
        const v = String(b.valeur ?? "").trim();
        if (!ok || !ok(v)) throw new Refus("Valeur invalide.");
        const p = await parametres();
        await sb.from("hr_parametres").upsert({ cle: b.cle, valeur: v }, { onConflict: "cle" });
        await journal("parametre", b.cle, "modification", { [b.cle]: p[b.cle] ?? null }, { [b.cle]: v }, motif);
        return json({ ok: true });
      }
      case "admin_journal": {
        const { data } = await sb.from("hr_journal").select("*").order("quand", { ascending: false }).limit(300);
        return json({ ok: true, journal: data || [] });
      }

      // ----- ancien rapport (compatibilité) -----
      case "admin_rapport": {
        const { debut, fin } = await bornes(b.debut, b.fin);
        const ls = await journees(debut, fin);
        return json({
          ok: true,
          lignes: ls.filter((l) => l.statut !== "a_venir").map((l) => ({
            jour: l.jour, jour_nom: JOURS[dow(l.jour)], nom: l.nom, service: l.service,
            prevu: l.prevu_debut ? `${hhmm(tMin(l.prevu_debut))}–${hhmm(tMin(l.prevu_fin))}` : "hors planning",
            arrivee: hhmm(l.arrivee_min), depart: hhmm(l.depart_min), duree_min: l.presence_min, retard_min: l.retard_min || null,
            alertes: [l.retard_min ? `Retard ${l.retard_min} min` : "", l.statut === "absence_injustifiee" ? "Absent" : "", l.statut === "depart_non_pointe" ? "Départ non pointé" : "", l.heures_sup_min ? `Heures sup ${l.heures_sup_min} min` : ""].filter(Boolean).join(" · "),
          })),
          refus: [],
        });
      }
    }
    return json({ erreur: "Action inconnue" }, 400);
  } catch (e) {
    if (e instanceof Refus) return json({ erreur: e.message }, e.code);
    console.error(e);
    return json({ erreur: "Erreur serveur, réessaie." }, 500);
  }
});
