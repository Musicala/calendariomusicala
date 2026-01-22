/* =============================================================================
  js/db.js — Firestore CRUD (events) — vPRO++
  -----------------------------------------------------------------------------
  ✅ create/update/softDelete/restore
  ✅ get + subscribe por rango (month-friendly)
  ✅ upsertMany (import) con sourceHash anti-duplicados
  ✅ Menos fragilidad con índices: rango usa SOLO orderBy(dateStart)

  Mejoras vPRO++:
  - Validación ISO más robusta
  - Normalización tolerante (update puede ser parcial si quieres)
  - Comparación de cambios real (no updates inútiles)
  - Mapper consistente para UI
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

/** Validación simple yyyy-mm-dd (y fecha real) */
function isValidISODate(dateISO) {
  if (!dateISO || typeof dateISO !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return false;
  const [y, m, d] = dateISO.split("-").map(n => parseInt(n, 10));
  if (!y || !m || !d) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && (dt.getMonth() + 1) === m && dt.getDate() === d;
}

/** Normaliza status */
function normalizeStatus(raw) {
  let st = normText(raw || "pending") || "pending";
  if (!ALLOWED_STATUS.has(st)) st = "pending";
  return st;
}

/** Compara strings con null safety */
function sameStr(a, b) {
  return String(a ?? "") === String(b ?? "");
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
========================= */
function normalizeEventInputStrict(input = {}) {
  const title = normText(input.title);
  const category = normText(input.category);
  const notes = normText(input.notes || "");
  const status = normalizeStatus(input.status);
  const dateISO = normText(input.dateISO || input.date || "");

  if (!title) throw new Error("El título es obligatorio.");
  if (!category) throw new Error("La categoría es obligatoria.");
  if (!dateISO) throw new Error("La fecha es obligatoria.");
  if (!isValidISODate(dateISO)) throw new Error("Fecha inválida. Usa yyyy-mm-dd.");

  return { title, category, status, notes, dateISO };
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
  const dateISO = normText(input.dateISO ?? input.date ?? fallback.dateISO ?? "");

  if (!title) throw new Error("El título es obligatorio.");
  if (!category) throw new Error("La categoría es obligatoria.");
  if (!dateISO) throw new Error("La fecha es obligatoria.");
  if (!isValidISODate(dateISO)) throw new Error("Fecha inválida. Usa yyyy-mm-dd.");

  return { title, category, status, notes, dateISO };
}

/* =========================
   CREATE
========================= */
export async function createEvent(input, userEmail) {
  const { title, category, status, notes, dateISO } = normalizeEventInputStrict(input);

  const email = normText(userEmail || "");

  const payload = {
    title,
    category,
    status,
    notes,
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
========================= */
export async function updateEvent(eventId, input, userEmail) {
  const id = normText(eventId);
  if (!id) throw new Error("eventId requerido");

  const email = normText(userEmail || "");

  // Para soportar update parcial, traemos el documento actual
  const ref = doc(db, "events", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("El evento no existe o fue eliminado.");

  const existing = mapEventDoc(snap);

  const incoming = normalizeEventInputTolerant(input, existing);

  const patch = {
    title: incoming.title,
    category: incoming.category,
    status: incoming.status,
    notes: incoming.notes,
    dateStart: dateISOToTimestamp(incoming.dateISO),
    dateISO: incoming.dateISO,
    updatedAt: serverTimestamp(),
    updatedBy: email
  };

  // Evita escribir si realmente no cambió nada (ahorra cuotas)
  const changed =
    !sameStr(existing.title, patch.title) ||
    !sameStr(existing.category, patch.category) ||
    !sameStr(existing.status, patch.status) ||
    !sameStr(existing.notes, patch.notes) ||
    !sameStr(existing.dateISO, patch.dateISO);

  if (!changed) {
    return { id, ...existing, _skipped: true };
  }

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
   Import helper: buscar por sourceHash
   (para evitar duplicados al importar TSV)
========================= */
export async function findEventBySourceHash(sourceHash) {
  const sh = normText(sourceHash);
  if (!sh) return null;

  const q = query(
    EVENTS_COL,
    where("sourceHash", "==", sh),
    limit(1)
  );

  const snaps = await getDocs(q);
  if (snaps.empty) return null;
  return mapEventDoc(snaps.docs[0]);
}

/* =========================
   Upsert many (import)
   - Si existe sourceHash: update
   - Si no existe: create
   - Skip si no cambia nada real
========================= */
export async function upsertMany(events = [], userEmail) {
  const results = { created: 0, updated: 0, skipped: 0, errors: 0 };
  const out = [];

  const email = normText(userEmail || "");

  for (const raw of (Array.isArray(events) ? events : [])) {
    try {
      const sourceHash = normText(raw?.sourceHash || "");

      // Sin hash => create normal (strict)
      if (!sourceHash) {
        const created = await createEvent(raw, email);
        results.created++;
        out.push(created);
        continue;
      }

      const existing = await findEventBySourceHash(sourceHash);

      if (!existing) {
        const created = await createEvent({ ...raw, sourceHash }, email);
        results.created++;
        out.push(created);
        continue;
      }

      // Tolerante: rellena lo que falte con existing
      const incoming = normalizeEventInputTolerant(raw, existing);

      const changed =
        !sameStr(incoming.title, existing.title) ||
        !sameStr(incoming.category, existing.category) ||
        !sameStr(incoming.status, existing.status) ||
        !sameStr(incoming.notes, existing.notes) ||
        !sameStr(incoming.dateISO, existing.dateISO);

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
