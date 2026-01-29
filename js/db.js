/* =============================================================================
  js/db.js — Firestore CRUD (events) — vPRO++++ (ASSIGNEE + RECURRENCE + FAST UPSERT)
  -----------------------------------------------------------------------------
  ✅ create/update/softDelete/restore
  ✅ get + subscribe por rango (month-friendly)
  ✅ upsertMany (import) con sourceHash anti-duplicados (optimizado con where-in)
  ✅ Rango usa SOLO orderBy(dateStart)

  Mejoras vPRO++++:
  - Campos nuevos:
      - assignedTo (persona asignada)
      - recurrence ("", "weekly", "monthly")  // simple y útil
  - Update parcial real: merge con existing, valida lo mínimo
  - Evita updates inútiles (comparación real)
  - findManyBySourceHash: resuelve hashes en bloques (hasta 10 por query)
  - upsertMany: menos lecturas, más velocidad, menos drama
  - Normalización más robusta + aliases tolerantes desde UI
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
const ALLOWED_RECURRENCE = new Set(["", "weekly", "monthly"]); // simple a propósito

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

function normalizeRecurrence(raw) {
  const r = normText(raw || "");
  return ALLOWED_RECURRENCE.has(r) ? r : "";
}

/** Null-safe string compare */
function sameStr(a, b) {
  return String(a ?? "") === String(b ?? "");
}

/** Pequeña ayuda: ignora undefined y deja null/"" explícitos */
function pickDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
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
   - strict: exige campos obligatorios (para create)
   - tolerant: rellena con fallback (para update/upsert)
   - soporta aliases desde UI para no romper
========================= */
function extractAssignedTo(input = {}, fallback = {}) {
  // soporta nombres alternos para no romper si UI cambia un id/prop
  const val =
    input.assignedTo ??
    input.assignee ??
    input.assigned ??
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
    fallback.recurrence ??
    "";
  return normalizeRecurrence(raw || "");
}

function extractDateISO(input = {}, fallback = {}) {
  // Soporta dateISO, date, dateStr...
  const raw =
    input.dateISO ??
    input.date ??
    input.dateStr ??
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

/**
 * Normaliza usando fallback (para update parcial o upsert).
 * Si no hay dateISO ni fallback, lanza.
 */
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

    assignedTo,   // 👈 NUEVO
    recurrence,   // 👈 NUEVO ("", "weekly", "monthly")

    dateStart: dateISOToTimestamp(dateISO),
    dateISO, // redundante a propósito: facilita filtros/UI

    createdBy: email,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: email,

    deletedAt: null,

    // import/metadata opcional
    source: normText(input?.source || "manual") || "manual",
    sourceHash: input?.sourceHash ? normText(input.sourceHash) : null
  };

  const ref = await addDoc(EVENTS_COL, payload);
  return { id: ref.id, ...payload };
}

/* =========================
   UPDATE
   - tolera input parcial: mezcla con evento existente si hace falta
   - evita escribir si no cambia nada real
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
    recurrence: incoming.recurrence,

    dateStart: dateISOToTimestamp(incoming.dateISO),
    dateISO: incoming.dateISO,

    updatedAt: serverTimestamp(),
    updatedBy: email
  });

  const changed =
    !sameStr(existing.title, patch.title) ||
    !sameStr(existing.category, patch.category) ||
    !sameStr(existing.status, patch.status) ||
    !sameStr(existing.notes, patch.notes) ||
    !sameStr(existing.dateISO, patch.dateISO) ||
    !sameStr(existing.assignedTo, patch.assignedTo) ||
    !sameStr(existing.recurrence, patch.recurrence);

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
   Query builder por rango
   - Filtra deletedAt == null
   - dateStart in [from..to]
   - orderBy SOLO dateStart (menos índices)
========================= */
function buildRangeQuery(fromDate, toDate) {
  if (!fromDate || !toDate) throw new Error("fromDate y toDate son requeridos");

  const from = Timestamp.fromDate(startOfDay(fromDate));
  const to = Timestamp.fromDate(endOfDay(toDate));

  return query(
    EVENTS_COL,
    where("deletedAt", "==", null),
    where("dateStart", ">=", from),
    where("dateStart", "<=", to),
    orderBy("dateStart", "asc")
  );
}

/* =========================
   GET por rango (month-friendly)
========================= */
export async function getEventsInRange(fromDate, toDate) {
  const q = buildRangeQuery(fromDate, toDate);
  const snaps = await getDocs(q);
  return snaps.docs.map(mapEventDoc);
}

/* =========================
   Realtime subscribe (ideal para UI)
========================= */
export function subscribeEventsInRange(fromDate, toDate, cb, onError) {
  const q = buildRangeQuery(fromDate, toDate);

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
   - Firestore "in" permite máx 10 valores por query
========================= */
export async function findManyBySourceHash(hashes = []) {
  const list = (Array.isArray(hashes) ? hashes : [])
    .map(h => normText(h))
    .filter(Boolean);

  const out = new Map(); // hash -> event
  if (!list.length) return out;

  const uniq = Array.from(new Set(list));

  for (let i = 0; i < uniq.length; i += 10) {
    const chunk = uniq.slice(i, i + 10);

    const q = query(
      EVENTS_COL,
      where("sourceHash", "in", chunk),
      limit(10)
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
   - Si existe sourceHash: update
   - Si no existe: create
   - Skip si no cambia nada real
   - Optimizado: resuelve existing por hash en bloque
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
        !sameStr(incoming.title, existing.title) ||
        !sameStr(incoming.category, existing.category) ||
        !sameStr(incoming.status, existing.status) ||
        !sameStr(incoming.notes, existing.notes) ||
        !sameStr(incoming.dateISO, existing.dateISO) ||
        !sameStr(incoming.assignedTo, existing.assignedTo) ||
        !sameStr(incoming.recurrence, existing.recurrence);

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
========================= */
function mapEventDoc(docSnap) {
  const data = docSnap.data() || {};

  const dateStart = data.dateStart || null;
  const dateISO = data.dateISO || toDateISO(dateStart);

  return {
    id: docSnap.id,

    title: data.title || "",
    category: data.category || "",
    status: data.status || "pending",
    notes: data.notes || "",

    assignedTo: data.assignedTo || "",
    recurrence: data.recurrence || "",

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
