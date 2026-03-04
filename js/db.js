/* =============================================================================
  js/db.js — Firestore CRUD (events) — vPRO∞ (RBAC READY + ASSIGNEE + RECURRENCE PRO + FAST UPSERT)
  -----------------------------------------------------------------------------
  ✅ create/update/softDelete/restore
  ✅ get + subscribe por rango (month-friendly)
  ✅ Filtro por categorías (allowedCategories) para roles (Académico/Admin)
  ✅ upsertMany (import) con sourceHash anti-duplicados (optimizado con where-in)
  ✅ Rango usa SOLO orderBy(dateStart) (menos índices)

  PRO Recurrence:
  - recurrence: null | { type:"interval", unit:"day|week|month|year", interval:number }
  - Backward compatible: "", "weekly", "monthly", "yearly"
  - Tolerante: puede venir JSON string en recurrence (ej: '{"unit":"week","interval":2}')

  RBAC (cliente):
  - buildRangeQuery(from,to,{ allowedCategories })
  - allowedCategories vacío -> no filtra (modo admin/legacy)
  - allowedCategories <= 10 -> where("category","in", allowedCategories)
  - >10 -> se omite el filtro (limitación Firestore "in")

  Nota inevitable: la seguridad real va en Firestore Rules. 🧱
============================================================================= */

import { db, serverTimestamp, Timestamp } from "./firebase.js";
import { startOfDay, endOfDay, toISODateLocal, normText } from "./utils.js";

import {
  collection,
  doc,
  addDoc,
  updateDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* =========================
   Collection ref
========================= */
const EVENTS_COL = collection(db, "events");

/* =========================
   Const / helpers
========================= */
const ALLOWED_STATUS = new Set(["pending", "done", "cancelled"]);

// Recurrence PRO
const RECURRENCE_UNITS = new Set(["day", "week", "month", "year"]);
const RECURRENCE_MAX_INTERVAL = 100;

// Firestore where-in max
const WHERE_IN_MAX = 10;

/** Validación simple yyyy-mm-dd (y fecha real) */
function isValidISODate(dateISO) {
  if (!dateISO || typeof dateISO !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return false;
  const [y, m, d] = dateISO.split("-").map(n => parseInt(n, 10));
  if (!y || !m || !d) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && (dt.getMonth() + 1) === m && dt.getDate() === d;
}

function normalizeStatus(raw) {
  let st = normText(raw || "pending") || "pending";
  if (!ALLOWED_STATUS.has(st)) st = "pending";
  return st;
}

/** Stable-ish stringify (para comparar objetos sin drama) */
function stableStringify(value) {
  try {
    if (value === null || value === undefined) return "";
    if (typeof value !== "object") return String(value);

    // Ordenar claves a un nivel (suficiente aquí)
    const keys = Object.keys(value).sort();
    const obj = {};
    for (const k of keys) obj[k] = value[k];
    return JSON.stringify(obj);
  } catch (_) {
    return "";
  }
}

/** Null-safe compare (soporta objetos) */
function sameValue(a, b) {
  if (a === b) return true;
  return stableStringify(a) === stableStringify(b);
}

/** Ignora undefined y deja null/"" explícitos */
function pickDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
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
/** Acepta objeto recurrence o string legacy o JSON string */
function normalizeRecurrence(raw) {
  if (raw === "" || raw === null || raw === undefined) return null;

  if (typeof raw === "string") {
    const s = normText(raw);

    // legacy
    if (s === "weekly")  return { type: "interval", unit: "week",  interval: 1 };
    if (s === "monthly") return { type: "interval", unit: "month", interval: 1 };
    if (s === "yearly")  return { type: "interval", unit: "year",  interval: 1 };

    // JSON string
    if (s.startsWith("{") && s.endsWith("}")) {
      try {
        const parsed = JSON.parse(raw);
        return normalizeRecurrence(parsed);
      } catch (_) {
        return null;
      }
    }

    return null;
  }

  if (typeof raw === "object") {
    const unit = normText(raw.unit || raw.frequency || raw.everyUnit || "");
    const intervalRaw = raw.interval ?? raw.every ?? raw.count ?? 1;
    const interval = parseInt(intervalRaw, 10);

    if (!RECURRENCE_UNITS.has(unit)) return null;
    if (!Number.isFinite(interval) || interval < 1 || interval > RECURRENCE_MAX_INTERVAL) return null;

    return { type: "interval", unit, interval };
  }

  return null;
}

/** Convierte recurrence object -> legacy string (solo para etiquetas / compat) */
export function recurrenceToLegacyString(rec) {
  const r = normalizeRecurrence(rec);
  if (!r) return "";
  if (r.unit === "week" && r.interval === 1) return "weekly";
  if (r.unit === "month" && r.interval === 1) return "monthly";
  if (r.unit === "year" && r.interval === 1) return "yearly";
  return "";
}

/* =========================
   Date helpers
========================= */
/** Convierte yyyy-mm-dd (local) -> Timestamp a 00:00 local */
export function dateISOToTimestamp(dateISO) {
  const iso = normText(dateISO);
  if (!isValidISODate(iso)) throw new Error("dateISO inválido (usa formato yyyy-mm-dd).");
  const [y, m, d] = iso.split("-").map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  return Timestamp.fromDate(dt);
}

/** Convierte Timestamp/Date -> yyyy-mm-dd local */
export function toDateISO(value) {
  if (!value) return "";
  const d = value instanceof Timestamp ? value.toDate() : new Date(value);
  return toISODateLocal(d);
}

/* =========================
   Normalizador de evento
   - strict: exige campos obligatorios (create)
   - tolerant: usa fallback (update/upsert)
   - soporta aliases desde UI
========================= */
function extractAssignedTo(input = {}, fallback = {}) {
  const val =
    input.assignedTo ??
    input.assignee ??
    input.assigned ??
    input.eventAssignedTo ??
    input.eventAssignee ??
    fallback.assignedTo ??
    fallback.assignee ??
    "";
  return normText(val || "");
}

function extractRecurrence(input = {}, fallback = {}) {
  const raw =
    input.recurrence ??
    input.repeat ??
    input.repetition ??
    input.eventRecurrence ??
    input.eventRepeat ??
    fallback.recurrence ??
    fallback.repeat ??
    fallback.repetition ??
    "";
  return normalizeRecurrence(raw);
}

function extractDateISO(input = {}, fallback = {}) {
  const raw =
    input.dateISO ??
    input.date ??
    input.dateStr ??
    input.eventDate ??
    fallback.dateISO ??
    fallback.date ??
    "";
  return normText(raw || "");
}

function normalizeEventInputStrict(input = {}) {
  const title = normText(input.title);
  const category = normText(input.category);
  const notes = normText(input.notes || "");
  const status = normalizeStatus(input.status);
  const dateISO = extractDateISO(input, {});

  const assignedTo = extractAssignedTo(input, {});
  const recurrence = extractRecurrence(input, {});

  if (!title) throw new Error("El título es obligatorio.");
  if (!category) throw new Error("La categoría es obligatoria.");
  if (!dateISO) throw new Error("La fecha es obligatoria.");
  if (!isValidISODate(dateISO)) throw new Error("Fecha inválida. Usa yyyy-mm-dd.");

  return { title, category, status, notes, dateISO, assignedTo, recurrence };
}

function normalizeEventInputTolerant(input = {}, fallback = {}) {
  const title = normText(input.title ?? fallback.title);
  const category = normText(input.category ?? fallback.category);
  const notes = normText((input.notes ?? fallback.notes) || "");
  const status = normalizeStatus(input.status ?? fallback.status ?? "pending");
  const dateISO = extractDateISO(input, fallback);

  const assignedTo = extractAssignedTo(input, fallback);
  const recurrence = extractRecurrence(input, fallback);

  if (!title) throw new Error("El título es obligatorio.");
  if (!category) throw new Error("La categoría es obligatoria.");
  if (!dateISO) throw new Error("La fecha es obligatoria.");
  if (!isValidISODate(dateISO)) throw new Error("Fecha inválida. Usa yyyy-mm-dd.");

  return { title, category, status, notes, dateISO, assignedTo, recurrence };
}

/* =========================
   CREATE
========================= */
export async function createEvent(input, userEmail) {
  const { title, category, status, notes, dateISO, assignedTo, recurrence } =
    normalizeEventInputStrict(input);

  const email = normText(userEmail || "");

  const payload = {
    title,
    category,
    status,
    notes,

    assignedTo,

    recurrence: recurrence || null,
    recurrenceLegacy: recurrenceToLegacyString(recurrence),

    dateStart: dateISOToTimestamp(dateISO),
    dateISO,

    createdBy: email,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: email,

    deletedAt: null,

    source: normText(input?.source || "manual") || "manual",
    sourceHash: input?.sourceHash ? normText(input.sourceHash) : null
  };

  const ref = await addDoc(EVENTS_COL, payload);
  return { id: ref.id, ...payload };
}

/* =========================
   UPDATE
========================= */
export async function updateEvent(eventId, input, userEmail) {
  const id = normText(eventId);
  if (!id) throw new Error("eventId requerido");

  const email = normText(userEmail || "");
  const ref = doc(db, "events", id);

  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("El evento no existe o fue eliminado.");

  const existing = mapEventDoc(snap);
  const incoming = normalizeEventInputTolerant(input, existing);

  const patch = pickDefined({
    title: incoming.title,
    category: incoming.category,
    status: incoming.status,
    notes: incoming.notes,

    assignedTo: incoming.assignedTo,

    recurrence: incoming.recurrence || null,
    recurrenceLegacy: recurrenceToLegacyString(incoming.recurrence),

    dateStart: dateISOToTimestamp(incoming.dateISO),
    dateISO: incoming.dateISO,

    updatedAt: serverTimestamp(),
    updatedBy: email
  });

  const changed =
    !sameValue(existing.title, patch.title) ||
    !sameValue(existing.category, patch.category) ||
    !sameValue(existing.status, patch.status) ||
    !sameValue(existing.notes, patch.notes) ||
    !sameValue(existing.dateISO, patch.dateISO) ||
    !sameValue(existing.assignedTo, patch.assignedTo) ||
    !sameValue(existing.recurrence, patch.recurrence);

  if (!changed) return { id, ...existing, _skipped: true };

  await updateDoc(ref, patch);
  return { id, ...existing, ...patch };
}

/* =========================
   SOFT DELETE (papelera)
========================= */
export async function softDeleteEvent(eventId, userEmail) {
  const id = normText(eventId);
  if (!id) throw new Error("eventId requerido");

  const ref = doc(db, "events", id);

  await updateDoc(ref, {
    deletedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: normText(userEmail || "")
  });

  return true;
}

/* =========================
   RESTORE
========================= */
export async function restoreEvent(eventId, userEmail) {
  const id = normText(eventId);
  if (!id) throw new Error("eventId requerido");

  const ref = doc(db, "events", id);

  await updateDoc(ref, {
    deletedAt: null,
    updatedAt: serverTimestamp(),
    updatedBy: normText(userEmail || "")
  });

  return true;
}

/* =========================
   GET ONE
========================= */
export async function getEvent(eventId) {
  const id = normText(eventId);
  if (!id) throw new Error("eventId requerido");

  const ref = doc(db, "events", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return mapEventDoc(snap);
}

/* =========================
   Query builder por rango (+ RBAC categorías)
   - Filtra deletedAt == null
   - dateStart in [from..to]
   - (opcional) category in allowedCategories
   - orderBy SOLO dateStart (menos índices)
========================= */
/**
 * @param {Date} fromDate
 * @param {Date} toDate
 * @param {Object} [opts]
 * @param {string[]} [opts.allowedCategories]
 */
function buildRangeQuery(fromDate, toDate, opts = {}) {
  if (!fromDate || !toDate) throw new Error("fromDate y toDate son requeridos");

  const from = Timestamp.fromDate(startOfDay(fromDate));
  const to = Timestamp.fromDate(endOfDay(toDate));

  const constraintsBase = [
    where("deletedAt", "==", null),
    where("dateStart", ">=", from),
    where("dateStart", "<=", to),
  ];

  const constraints = withCategoryFilter_(constraintsBase, opts.allowedCategories);

  return query(
    EVENTS_COL,
    ...constraints,
    orderBy("dateStart", "asc")
  );
}

/* =========================
   GET por rango (month-friendly)
========================= */
export async function getEventsInRange(fromDate, toDate, opts = {}) {
  const q = buildRangeQuery(fromDate, toDate, opts);
  const snaps = await getDocs(q);
  return snaps.docs.map(mapEventDoc);
}

/* =========================
   Realtime subscribe (ideal para UI)
========================= */
export function subscribeEventsInRange(fromDate, toDate, cb, onError, opts = {}) {
  const q = buildRangeQuery(fromDate, toDate, opts);

  return onSnapshot(
    q,
    (snap) => {
      const events = snap.docs.map(mapEventDoc);
      cb?.(events);
    },
    (err) => {
      console.error("subscribeEventsInRange error:", err);
      onError?.(err);
    }
  );
}

/* =========================
   Import helper: buscar por sourceHash (single)
========================= */
export async function findEventBySourceHash(sourceHash) {
  const sh = normText(sourceHash);
  if (!sh) return null;

  const q = query(EVENTS_COL, where("sourceHash", "==", sh), limit(1));
  const snaps = await getDocs(q);
  if (snaps.empty) return null;
  return mapEventDoc(snaps.docs[0]);
}

/* =========================
   Import helper: buscar MUCHOS sourceHash (fast)
========================= */
export async function findManyBySourceHash(hashes = []) {
  const list = (Array.isArray(hashes) ? hashes : [])
    .map(h => normText(h))
    .filter(Boolean);

  const out = new Map(); // hash -> event
  if (!list.length) return out;

  const uniq = Array.from(new Set(list));

  for (let i = 0; i < uniq.length; i += WHERE_IN_MAX) {
    const chunk = uniq.slice(i, i + WHERE_IN_MAX);

    const q = query(
      EVENTS_COL,
      where("sourceHash", "in", chunk),
      limit(WHERE_IN_MAX)
    );

    const snaps = await getDocs(q);
    for (const d of snaps.docs) {
      const ev = mapEventDoc(d);
      if (ev.sourceHash) out.set(ev.sourceHash, ev);
    }
  }

  return out;
}

/* =========================
   Upsert many (import)
========================= */
export async function upsertMany(events = [], userEmail) {
  const results = { created: 0, updated: 0, skipped: 0, errors: 0 };
  const out = [];

  const email = normText(userEmail || "");
  const items = Array.isArray(events) ? events : [];

  const hashes = items.map(r => normText(r?.sourceHash || "")).filter(Boolean);
  let existingByHash = new Map();

  try {
    existingByHash = await findManyBySourceHash(hashes);
  } catch (e) {
    console.warn("findManyBySourceHash failed, fallback to per-item:", e);
    existingByHash = new Map();
  }

  for (const raw of items) {
    try {
      const sourceHash = normText(raw?.sourceHash || "");

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
        !sameValue(incoming.title, existing.title) ||
        !sameValue(incoming.category, existing.category) ||
        !sameValue(incoming.status, existing.status) ||
        !sameValue(incoming.notes, existing.notes) ||
        !sameValue(incoming.dateISO, existing.dateISO) ||
        !sameValue(incoming.assignedTo, existing.assignedTo) ||
        !sameValue(incoming.recurrence, existing.recurrence);

      if (!changed) {
        results.skipped++;
        out.push(existing);
        continue;
      }

      await updateEvent(existing.id, incoming, email);
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
   Mapper doc -> objeto usable en UI
   - Convierte recurrence legacy/string -> objeto
========================= */
function mapEventDoc(docSnap) {
  const data = docSnap.data() || {};

  const dateStart = data.dateStart || null;
  const dateISO = data.dateISO || toDateISO(dateStart);

  const rec =
    (data.recurrence !== undefined ? data.recurrence : null) ??
    (data.recurrenceLegacy !== undefined ? data.recurrenceLegacy : null) ??
    "";

  const recurrence = normalizeRecurrence(rec);

  return {
    id: docSnap.id,

    title: data.title || "",
    category: data.category || "",
    status: data.status || "pending",
    notes: data.notes || "",

    assignedTo: data.assignedTo || "",

    recurrence,
    recurrenceLegacy: data.recurrenceLegacy || recurrenceToLegacyString(recurrence),

    dateStart,
    dateISO,

    createdBy: data.createdBy || "",
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || "",

    deletedAt: data.deletedAt ?? null,

    source: data.source || "manual",
    sourceHash: data.sourceHash || null
  };
}