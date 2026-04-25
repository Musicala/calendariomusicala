/* =============================================================================
  js/db.js — Firestore CRUD (events + users)
  -----------------------------------------------------------------------------
  NUEVO:
    getUserProfile(uid)     → lee users/{uid} desde Firestore
    createUserProfile(user) → crea users/{uid} con role "comunidad" por defecto

  EXISTENTE (sin cambios):
    createEvent / updateEvent / softDeleteEvent / restoreEvent
    getEvent / getEventsInRange / subscribeEventsInRange
    upsertMany / findEventBySourceHash / findManyBySourceHash
    recurrenceToLegacyString / dateISOToTimestamp / toDateISO

  RBAC cliente (categorías filtradas):
    buildRangeQuery usa allowedCategories para filtrar Firestore
    (la seguridad real está en Firestore Rules)
============================================================================= */

import { db, serverTimestamp, Timestamp } from "./firebase.js";
import { startOfDay, endOfDay, toISODateLocal, normText } from "./utils.js";
import { DEFAULT_CATEGORIES, DEFAULT_ASSIGNEES } from "./constants.js";

import {
  collection,
  doc,
  addDoc,
  updateDoc,
  getDoc,
  setDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* =========================
   Collection refs
========================= */
const EVENTS_COL = collection(db, "events");
const USERS_COL  = "users"; // string, usamos doc(db, USERS_COL, uid)
const SETTINGS_DOC = doc(db, "settings", "catalogs");

/* =============================================================================
   GESTIÓN DE USUARIOS (users/{uid})
   ─────────────────────────────────
   Estructura del documento de usuario en Firestore:
   {
     email:       string,
     displayName: string,
     role:        "direccion" | "administrativo" | "comercial" | "docente" | "comunidad",
     active:      boolean,
     createdAt:   Timestamp  (solo al crear)
   }

   Notas de diseño:
   - El UID de Firebase Auth es el ID del documento (no un campo aparte)
   - "active: false" bloquea el acceso aunque el rol exista
   - Los campos allowedCategories y canWrite que puedas ver en Firestore
     son IGNORADOS — la fuente de verdad es ROLE_PERMISSIONS en constants.js
   - Al crear automáticamente un nuevo usuario, siempre recibe role "comunidad"
============================================================================= */

/**
 * Lee el perfil de un usuario desde Firestore.
 * @param {string} uid — Firebase Auth UID
 * @returns {Promise<{uid: string, email: string, displayName: string, role: string, active: boolean} | null>}
 */
export async function getUserProfile(uid) {
  if (!uid) return null;

  try {
    const ref = doc(db, USERS_COL, uid);
    const snap = await getDoc(ref);

    if (!snap.exists()) return null;

    const data = snap.data() || {};

    return {
      uid: snap.id,
      email:       String(data.email       || "").trim(),
      displayName: String(data.displayName || "").trim(),
      role:        String(data.role        || "comunidad").trim(),
      active:      data.active !== false // undefined o true → activo; solo false → bloqueado
    };
  } catch (err) {
    console.error("[db] getUserProfile error:", err);
    throw err; // lo maneja auth.js con fallback
  }
}

/**
 * Crea un perfil nuevo en Firestore para un usuario de Firebase Auth.
 * Solo se llama si getUserProfile() devuelve null (usuario nuevo).
 * Siempre asigna role "comunidad" y active true.
 *
 * @param {{ uid: string, email: string|null, displayName: string|null }} firebaseUser
 * @returns {Promise<{uid: string, email: string, displayName: string, role: string, active: boolean}>}
 */
export async function createUserProfile(firebaseUser) {
  const { uid, email, displayName } = firebaseUser || {};

  if (!uid) throw new Error("createUserProfile: uid requerido.");

  const profile = {
    email:       String(email       || "").trim().toLowerCase(),
    displayName: String(displayName || email || "").trim(),
    role:        "comunidad",
    active:      true,
    createdAt:   serverTimestamp()
  };

  try {
    const ref = doc(db, USERS_COL, uid);
    await setDoc(ref, profile);

    return {
      uid,
      email:       profile.email,
      displayName: profile.displayName,
      role:        profile.role,
      active:      profile.active
    };
  } catch (err) {
    console.error("[db] createUserProfile error:", err);
    throw err;
  }
}

export async function getCatalogSettings() {
  try {
    const snap = await getDoc(SETTINGS_DOC);
    if (!snap.exists()) {
      return {
        categories: DEFAULT_CATEGORIES,
        assignees: DEFAULT_ASSIGNEES
      };
    }

    const data = snap.data() || {};
    return {
      categories: Array.isArray(data.categories) ? data.categories : DEFAULT_CATEGORIES,
      assignees: Array.isArray(data.assignees) ? data.assignees : DEFAULT_ASSIGNEES
    };
  } catch (err) {
    console.error("[db] getCatalogSettings error:", err);
    throw err;
  }
}

export async function saveCatalogSettings({ categories, assignees } = {}, userEmail = "") {
  const patch = {
    updatedAt: serverTimestamp(),
    updatedBy: cleanString(userEmail, "")
  };

  if (Array.isArray(categories)) patch.categories = categories;
  if (Array.isArray(assignees)) patch.assignees = assignees;

  await setDoc(SETTINGS_DOC, patch, { merge: true });
  return true;
}

/* =============================================================================
   TODO LO QUE SIGUE ES EL CÓDIGO ORIGINAL DE EVENTOS — SIN CAMBIOS
============================================================================= */

/* =========================
   Const / helpers
========================= */
const ALLOWED_STATUS        = new Set(["pending", "done", "cancelled"]);
const RECURRENCE_UNITS      = new Set(["day", "week", "month", "year"]);
const RECURRENCE_MAX_INTERVAL = 100;
const WHERE_IN_MAX          = 10;

/* =========================
   Date validation helpers
========================= */
function isValidISODate(dateISO) {
  if (!dateISO || typeof dateISO !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return false;
  const [y, m, d] = dateISO.split("-").map(n => parseInt(n, 10));
  if (!y || !m || !d) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && (dt.getMonth() + 1) === m && dt.getDate() === d;
}

function normalizeISODate(dateISO) {
  const iso = String(dateISO || "").trim();
  return isValidISODate(iso) ? iso : "";
}

function normalizeStatus(raw) {
  const st = normText(raw || "pending") || "pending";
  return ALLOWED_STATUS.has(st) ? st : "pending";
}

/* =========================
   Generic utils
========================= */
function stableStringify(value) {
  try {
    if (value === null || value === undefined) return "";
    if (typeof value !== "object") return String(value);
    if (Array.isArray(value)) {
      return JSON.stringify(value.map(v => {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const keys = Object.keys(v).sort();
          const o = {};
          for (const k of keys) o[k] = v[k];
          return o;
        }
        return v;
      }));
    }
    const keys = Object.keys(value).sort();
    const obj = {};
    for (const k of keys) obj[k] = value[k];
    return JSON.stringify(obj);
  } catch (_) { return ""; }
}

function sameValue(a, b) {
  if (a === b) return true;
  return stableStringify(a) === stableStringify(b);
}

function pickDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function cleanString(raw, fallback = "") {
  if (raw === undefined || raw === null) return fallback;
  return String(raw).trim();
}

/* =========================
   RBAC helpers (categorías)
========================= */
function normalizeAllowedCategories_(allowedCategories) {
  const arr = Array.isArray(allowedCategories) ? allowedCategories : [];
  const clean = arr.map(c => normText(c)).filter(Boolean);
  return Array.from(new Set(clean));
}

function withCategoryFilter_(constraints, allowedCategories) {
  const cats = normalizeAllowedCategories_(allowedCategories);
  if (!cats.length) return constraints;
  if (cats.length > WHERE_IN_MAX) {
    console.warn(
      `[db] allowedCategories tiene ${cats.length} items (>10). ` +
      `Firestore no soporta where-in > 10. Se omitirá el filtro de categoría.`
    );
    return constraints;
  }
  return [...constraints, where("category", "in", cats)];
}

/* =========================
   Recurrence helpers
========================= */
function normalizeRecurrence(raw) {
  if (raw === "" || raw === null || raw === undefined) return null;

  if (typeof raw === "string") {
    const trimmed = String(raw).trim();
    const lowered = trimmed.toLowerCase();
    if (lowered === "weekly")  return { type: "interval", unit: "week",  interval: 1 };
    if (lowered === "monthly") return { type: "interval", unit: "month", interval: 1 };
    if (lowered === "yearly")  return { type: "interval", unit: "year",  interval: 1 };
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try { return normalizeRecurrence(JSON.parse(trimmed)); }
      catch (_) { return null; }
    }
    return null;
  }

  if (typeof raw === "object") {
    const unit = normText(raw.unit || raw.frequency || raw.everyUnit || "");
    const intervalRaw = raw.interval ?? raw.every ?? raw.count ?? 1;
    const interval = parseInt(intervalRaw, 10);
    if (!RECURRENCE_UNITS.has(unit)) return null;
    if (!Number.isFinite(interval) || interval < 1 || interval > RECURRENCE_MAX_INTERVAL) return null;
    const normalized = { type: "interval", unit, interval };
    if (unit === "month") {
      const mode = normText(raw.mode || raw.monthMode || "");
      const dayOfMonth = parseInt(raw.dayOfMonth ?? raw.day ?? "", 10);
      if (mode === "dayofmonth" && Number.isFinite(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31) {
        normalized.mode = "dayOfMonth";
        normalized.dayOfMonth = dayOfMonth;
      }
    }
    return normalized;
  }
  return null;
}

function sanitizeRecurrenceForStorage(raw) {
  const rec = normalizeRecurrence(raw);
  if (!rec) return null;
  const out = { type: "interval", unit: rec.unit, interval: rec.interval };
  if (rec.unit === "month" && rec.mode === "dayOfMonth" && Number.isFinite(rec.dayOfMonth)) {
    out.mode = "dayOfMonth";
    out.dayOfMonth = rec.dayOfMonth;
  }
  return out;
}

export function recurrenceToLegacyString(rec) {
  const r = normalizeRecurrence(rec);
  if (!r) return "";
  if (r.unit === "week"  && r.interval === 1 && !r.mode) return "weekly";
  if (r.unit === "month" && r.interval === 1 && !r.mode) return "monthly";
  if (r.unit === "year"  && r.interval === 1)            return "yearly";
  return "";
}

/* =========================
   Date helpers
========================= */
export function dateISOToTimestamp(dateISO) {
  const iso = normalizeISODate(dateISO);
  if (!iso) throw new Error("dateISO inválido (usa formato yyyy-mm-dd).");
  const [y, m, d] = iso.split("-").map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  return Timestamp.fromDate(dt);
}

export function toDateISO(value) {
  if (!value) return "";
  const d = value instanceof Timestamp ? value.toDate() : new Date(value);
  return toISODateLocal(d);
}

/* =========================
   Input extraction
========================= */
function extractAssignedTo(input = {}, fallback = {}) {
  const val =
    input.assignedTo    ?? input.assignee  ?? input.assigned ??
    input.eventAssignedTo ?? input.eventAssignee ??
    fallback.assignedTo ?? fallback.assignee ?? "";
  return cleanString(val, "");
}

function extractRecurrence(input = {}, fallback = {}) {
  const raw =
    input.recurrence  ?? input.repeat       ?? input.repetition ??
    input.eventRecurrence ?? input.eventRepeat ??
    fallback.recurrence ?? fallback.repeat   ?? fallback.repetition ?? "";
  return sanitizeRecurrenceForStorage(raw);
}

function extractRecurrenceParentId(input = {}, fallback = {}) {
  const raw =
    input.recurrenceParentId ?? input.seriesParentId ?? input.parentEventId ??
    fallback.recurrenceParentId ?? fallback.seriesParentId ?? fallback.parentEventId ?? "";
  return cleanString(raw, "");
}

function extractRecurrenceSkip(input = {}, fallback = {}) {
  if ("recurrenceSkip" in input) return !!input.recurrenceSkip;
  if ("skipRecurrence" in input) return !!input.skipRecurrence;
  if ("recurrenceSkip" in fallback) return !!fallback.recurrenceSkip;
  return false;
}

function extractDateISO(input = {}, fallback = {}) {
  const raw =
    input.dateISO ?? input.date ?? input.dateStr ?? input.eventDate ??
    fallback.dateISO ?? fallback.date ?? "";
  return normalizeISODate(raw);
}

function normalizeEventInputStrict(input = {}) {
  const title      = cleanString(input.title);
  const category   = normText(input.category);
  const notes      = cleanString(input.notes, "");
  const status     = normalizeStatus(input.status);
  const dateISO    = extractDateISO(input, {});
  const assignedTo = extractAssignedTo(input, {});
  const recurrence = extractRecurrence(input, {});
  const recurrenceParentId = extractRecurrenceParentId(input, {});
  const recurrenceSkip = extractRecurrenceSkip(input, {});

  if (!title)   throw new Error("El título es obligatorio.");
  if (!category) throw new Error("La categoría es obligatoria.");
  if (!dateISO)  throw new Error("La fecha es obligatoria.");
  if (!isValidISODate(dateISO)) throw new Error("Fecha inválida. Usa yyyy-mm-dd.");

  return { title, category, status, notes, dateISO, assignedTo, recurrence, recurrenceParentId, recurrenceSkip };
}

function normalizeEventInputTolerant(input = {}, fallback = {}) {
  const title      = cleanString(input.title      ?? fallback.title);
  const category   = normText(input.category      ?? fallback.category);
  const notes      = cleanString(input.notes      ?? fallback.notes, "");
  const status     = normalizeStatus(input.status ?? fallback.status ?? "pending");
  const dateISO    = extractDateISO(input, fallback);
  const assignedTo = extractAssignedTo(input, fallback);
  const recurrence = extractRecurrence(input, fallback);
  const recurrenceParentId = extractRecurrenceParentId(input, fallback);
  const recurrenceSkip = extractRecurrenceSkip(input, fallback);

  if (!title)   throw new Error("El título es obligatorio.");
  if (!category) throw new Error("La categoría es obligatoria.");
  if (!dateISO)  throw new Error("La fecha es obligatoria.");
  if (!isValidISODate(dateISO)) throw new Error("Fecha inválida. Usa yyyy-mm-dd.");

  return { title, category, status, notes, dateISO, assignedTo, recurrence, recurrenceParentId, recurrenceSkip };
}

function normalizePartialPatch(input = {}, existing = {}) {
  const patch = {};

  if ("title" in input) {
    const title = cleanString(input.title);
    if (!title) throw new Error("El título no puede quedar vacío.");
    patch.title = title;
  }
  if ("category" in input) {
    const category = normText(input.category);
    if (!category) throw new Error("La categoría no puede quedar vacía.");
    patch.category = category;
  }
  if ("status" in input) {
    patch.status = normalizeStatus(input.status);
  }
  if ("notes" in input) {
    patch.notes = cleanString(input.notes, "");
  }
  if ("assignedTo" in input || "assignee" in input || "assigned" in input ||
      "eventAssignedTo" in input || "eventAssignee" in input) {
    patch.assignedTo = extractAssignedTo(input, existing);
  }
  if ("dateISO" in input || "date" in input || "dateStr" in input || "eventDate" in input) {
    const dateISO = extractDateISO(input, existing);
    if (!dateISO) throw new Error("La fecha es obligatoria.");
    patch.dateISO   = dateISO;
    patch.dateStart = dateISOToTimestamp(dateISO);
  }
  if ("recurrence" in input || "repeat" in input || "repetition" in input ||
      "eventRecurrence" in input || "eventRepeat" in input) {
    const recurrence = extractRecurrence(input, existing);
    patch.recurrence       = recurrence || null;
    patch.recurrenceLegacy = recurrenceToLegacyString(recurrence);
  }
  if ("recurrenceParentId" in input || "seriesParentId" in input || "parentEventId" in input) {
    patch.recurrenceParentId = extractRecurrenceParentId(input, existing) || null;
  }
  if ("recurrenceSkip" in input || "skipRecurrence" in input) {
    patch.recurrenceSkip = extractRecurrenceSkip(input, existing);
  }

  return patch;
}

/* =========================
   CREATE
========================= */
export async function createEvent(input, userEmail) {
  const { title, category, status, notes, dateISO, assignedTo, recurrence, recurrenceParentId, recurrenceSkip } =
    normalizeEventInputStrict(input);

  const email = cleanString(userEmail, "");

  const payload = {
    title, category, status, notes, assignedTo,
    recurrence:        recurrence || null,
    recurrenceParentId: recurrenceParentId || null,
    recurrenceSkip:    !!recurrenceSkip,
    recurrenceLegacy:  recurrenceToLegacyString(recurrence),
    dateStart:         dateISOToTimestamp(dateISO),
    dateISO,
    createdBy:  email,
    createdAt:  serverTimestamp(),
    updatedAt:  serverTimestamp(),
    updatedBy:  email,
    deletedAt:  null,
    source:     normText(input?.source || "manual") || "manual",
    sourceHash: input?.sourceHash ? cleanString(input.sourceHash, "") : null
  };

  const ref = await addDoc(EVENTS_COL, payload);
  return { id: ref.id, ...payload };
}

/* =========================
   UPDATE
========================= */
export async function updateEvent(eventId, input, userEmail) {
  const id = cleanString(eventId, "");
  if (!id) throw new Error("eventId requerido");

  const email = cleanString(userEmail, "");
  const ref = doc(db, "events", id);

  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("El evento no existe o fue eliminado.");

  const existing = mapEventDoc(snap);

  let patch = {};
  const hasKnownPatchField =
    "title" in (input || {}) || "category" in (input || {}) || "status" in (input || {}) ||
    "notes" in (input || {}) || "assignedTo" in (input || {}) || "assignee" in (input || {}) ||
    "assigned" in (input || {}) || "eventAssignedTo" in (input || {}) || "eventAssignee" in (input || {}) ||
    "dateISO" in (input || {}) || "date" in (input || {}) || "dateStr" in (input || {}) ||
    "eventDate" in (input || {}) || "recurrence" in (input || {}) || "repeat" in (input || {}) ||
    "repetition" in (input || {}) || "eventRecurrence" in (input || {}) || "eventRepeat" in (input || {}) ||
    "recurrenceParentId" in (input || {}) || "seriesParentId" in (input || {}) || "parentEventId" in (input || {}) ||
    "recurrenceSkip" in (input || {}) || "skipRecurrence" in (input || {});

  if (hasKnownPatchField) {
    patch = normalizePartialPatch(input, existing);
  } else {
    const normalized = normalizeEventInputTolerant(input, existing);
    patch = {
      title: normalized.title, category: normalized.category,
      status: normalized.status, notes: normalized.notes,
      assignedTo: normalized.assignedTo,
      recurrence: normalized.recurrence || null,
      recurrenceParentId: normalized.recurrenceParentId || null,
      recurrenceSkip: normalized.recurrenceSkip,
      recurrenceLegacy: recurrenceToLegacyString(normalized.recurrence),
      dateISO: normalized.dateISO,
      dateStart: dateISOToTimestamp(normalized.dateISO)
    };
  }

  const changed =
    ("title"      in patch && !sameValue(existing.title,      patch.title))      ||
    ("category"   in patch && !sameValue(existing.category,   patch.category))   ||
    ("status"     in patch && !sameValue(existing.status,     patch.status))     ||
    ("notes"      in patch && !sameValue(existing.notes,      patch.notes))      ||
    ("dateISO"    in patch && !sameValue(existing.dateISO,    patch.dateISO))    ||
    ("assignedTo" in patch && !sameValue(existing.assignedTo, patch.assignedTo)) ||
    ("recurrence" in patch && !sameValue(existing.recurrence, patch.recurrence)) ||
    ("recurrenceParentId" in patch && !sameValue(existing.recurrenceParentId, patch.recurrenceParentId)) ||
    ("recurrenceSkip" in patch && !sameValue(existing.recurrenceSkip, patch.recurrenceSkip));

  if (!changed) return { id, ...existing, _skipped: true };

  const finalPatch = pickDefined({
    ...patch,
    updatedAt: serverTimestamp(),
    updatedBy: email
  });

  await updateDoc(ref, finalPatch);
  return { id, ...existing, ...patch };
}

/* =========================
   SOFT DELETE
========================= */
export async function softDeleteEvent(eventId, userEmail) {
  const id = cleanString(eventId, "");
  if (!id) throw new Error("eventId requerido");
  const ref = doc(db, "events", id);
  await updateDoc(ref, {
    deletedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: cleanString(userEmail, "")
  });
  return true;
}

/* =========================
   RESTORE
========================= */
export async function restoreEvent(eventId, userEmail) {
  const id = cleanString(eventId, "");
  if (!id) throw new Error("eventId requerido");
  const ref = doc(db, "events", id);
  await updateDoc(ref, {
    deletedAt: null,
    updatedAt: serverTimestamp(),
    updatedBy: cleanString(userEmail, "")
  });
  return true;
}

/* =========================
   GET ONE
========================= */
export async function getEvent(eventId) {
  const id = cleanString(eventId, "");
  if (!id) throw new Error("eventId requerido");
  const ref = doc(db, "events", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return mapEventDoc(snap);
}

/* =========================
   Query builder (+ RBAC categorías)
========================= */
function buildRangeQuery(fromDate, toDate, opts = {}) {
  if (!fromDate || !toDate) throw new Error("fromDate y toDate son requeridos");

  const from = Timestamp.fromDate(startOfDay(fromDate));
  const to   = Timestamp.fromDate(endOfDay(toDate));

  const constraintsBase = [
    where("deletedAt", "==", null),
    where("dateStart", ">=", from),
    where("dateStart", "<=", to)
  ];

  const constraints = withCategoryFilter_(constraintsBase, opts.allowedCategories);

  return query(EVENTS_COL, ...constraints, orderBy("dateStart", "asc"));
}

/* =========================
   GET por rango
========================= */
export async function getEventsInRange(fromDate, toDate, opts = {}) {
  const q = buildRangeQuery(fromDate, toDate, opts);
  const snaps = await getDocs(q);
  return snaps.docs.map(mapEventDoc);
}

/* =========================
   Realtime subscribe
========================= */
export function subscribeEventsInRange(fromDate, toDate, cb, onError, opts = {}) {
  const q = buildRangeQuery(fromDate, toDate, opts);
  return onSnapshot(
    q,
    (snap) => cb?.(snap.docs.map(mapEventDoc)),
    (err)  => { console.error("subscribeEventsInRange error:", err); onError?.(err); }
  );
}

/* =========================
   Import helpers
========================= */
export async function findEventBySourceHash(sourceHash) {
  const sh = cleanString(sourceHash, "");
  if (!sh) return null;
  const q = query(EVENTS_COL, where("sourceHash", "==", sh), limit(1));
  const snaps = await getDocs(q);
  if (snaps.empty) return null;
  return mapEventDoc(snaps.docs[0]);
}

export async function findManyBySourceHash(hashes = []) {
  const list = (Array.isArray(hashes) ? hashes : [])
    .map(h => cleanString(h, ""))
    .filter(Boolean);

  const out = new Map();
  if (!list.length) return out;

  const uniq = Array.from(new Set(list));

  for (let i = 0; i < uniq.length; i += WHERE_IN_MAX) {
    const chunk = uniq.slice(i, i + WHERE_IN_MAX);
    const q = query(EVENTS_COL, where("sourceHash", "in", chunk));
    const snaps = await getDocs(q);
    for (const d of snaps.docs) {
      const ev = mapEventDoc(d);
      if (ev.sourceHash) out.set(ev.sourceHash, ev);
    }
  }

  return out;
}

/* =========================
   Upsert many
========================= */
export async function upsertMany(events = [], userEmail) {
  const results = { created: 0, updated: 0, skipped: 0, errors: 0 };
  const out = [];

  const email = cleanString(userEmail, "");
  const items = Array.isArray(events) ? events : [];

  const hashes = items.map(r => cleanString(r?.sourceHash, "")).filter(Boolean);
  let existingByHash = new Map();

  try { existingByHash = await findManyBySourceHash(hashes); }
  catch (e) { console.warn("findManyBySourceHash failed, fallback to per-item:", e); }

  for (const raw of items) {
    try {
      const sourceHash = cleanString(raw?.sourceHash, "");

      if (!sourceHash) {
        const created = await createEvent(raw, email);
        results.created++;
        out.push(created);
        continue;
      }

      let existing = existingByHash.get(sourceHash) || null;
      if (!existing) {
        existing = await findEventBySourceHash(sourceHash);
        if (existing) existingByHash.set(sourceHash, existing);
      }

      if (!existing) {
        const created = await createEvent({ ...raw, sourceHash }, email);
        results.created++;
        out.push(created);
        continue;
      }

      const incoming = normalizeEventInputTolerant(raw, existing);
      const changed =
        !sameValue(incoming.title,      existing.title)      ||
        !sameValue(incoming.category,   existing.category)   ||
        !sameValue(incoming.status,     existing.status)     ||
        !sameValue(incoming.notes,      existing.notes)      ||
        !sameValue(incoming.dateISO,    existing.dateISO)    ||
        !sameValue(incoming.assignedTo, existing.assignedTo) ||
        !sameValue(incoming.recurrence, existing.recurrence);

      if (!changed) {
        results.skipped++;
        out.push(existing);
        continue;
      }

      await updateEvent(existing.id, {
        title: incoming.title, category: incoming.category,
        status: incoming.status, notes: incoming.notes,
        assignedTo: incoming.assignedTo,
        recurrence: incoming.recurrence, dateISO: incoming.dateISO
      }, email);

      results.updated++;
      out.push({ ...existing, ...incoming, id: existing.id });

    } catch (e) {
      console.warn("upsertMany error:", e);
      results.errors++;
    }
  }

  return { results, items: out };
}

/* =========================
   Mapper doc → objeto UI
========================= */
function mapEventDoc(docSnap) {
  const data = docSnap.data() || {};

  const dateStart = data.dateStart || null;
  const dateISO   = cleanString(data.dateISO, "") || toDateISO(dateStart);

  const rec =
    (data.recurrence !== undefined ? data.recurrence : null) ??
    (data.recurrenceLegacy !== undefined ? data.recurrenceLegacy : null) ?? "";

  const recurrence = normalizeRecurrence(rec);

  return {
    id:              docSnap.id,
    title:           cleanString(data.title,   ""),
    category:        cleanString(data.category,""),
    status:          normalizeStatus(data.status || "pending"),
    notes:           cleanString(data.notes,   ""),
    assignedTo:      cleanString(data.assignedTo, ""),
    recurrence,
    recurrenceParentId: cleanString(data.recurrenceParentId, ""),
    recurrenceSkip: !!data.recurrenceSkip,
    recurrenceLegacy: cleanString(data.recurrenceLegacy, "") || recurrenceToLegacyString(recurrence),
    dateStart,
    dateISO,
    createdBy:  cleanString(data.createdBy,  ""),
    createdAt:  data.createdAt  || null,
    updatedAt:  data.updatedAt  || null,
    updatedBy:  cleanString(data.updatedBy,  ""),
    deletedAt:  data.deletedAt  ?? null,
    source:     cleanString(data.source, "manual") || "manual",
    sourceHash: cleanString(data.sourceHash, "") || null
  };
}
