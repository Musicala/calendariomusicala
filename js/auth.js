/* =============================================================================
  js/auth.js — Login/Logout + Allowlist + Roles (Administrativo/Académico) + UI gating (mejorado)
  - Google Sign-In con popup
  - Solo permite entrar a correos específicos (allowlist)
  - Asigna rol por email: "administrativo" | "academico"
  - Deriva permisos: canWrite + allowedCategories
  - Muestra/oculta #app y #unauthorized
  - Emite evento "auth:changed" para que app.js reaccione:
      { user, allowed, email, role, canWrite, allowedCategories }
============================================================================= */

import { auth, googleProvider } from "./firebase.js";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

/* =========================
   Roles por email (solo 2 roles)
   - TODO email que no esté aquí: NO entra.
   - Cambien/añadan docentes en el mapa y listo.
========================= */

/**
 * @typedef {"administrativo"|"academico"} Role
 */

const EMAIL_ROLE_MAP = new Map([
  // Administrativos (full access)
  ["musicalaasesor@gmail.com", "administrativo"],
  ["imusicala@gmail.com", "administrativo"],
  ["alekcaballeromusic@gmail.com", "administrativo"],
  ["catalina.medina.leal@gmail.com", "administrativo"],

  // Académico (solo lectura, solo ve "academico")
  // Ejemplo:
  // ["profe1@musicala.com", "academico"],
]);

const ALLOWED_EMAILS = new Set([...EMAIL_ROLE_MAP.keys()]);

/**
 * Categorías visibles por rol.
 * Ajusten si quieren que Administrativo vea menos.
 */
const ROLE_CATEGORIES = {
  academico: ["academico"],
  administrativo: [
    "administrativo",
    "financiero",
    "sgsst",
    "atc_ventas",
    "academico",
    "eventos",
    "marketing",
    "cumpleanos",
    "otro",
  ],
};

/**
 * Permiso de escritura por rol.
 * - Académico: solo ver (no editar)
 * - Administrativo: puede editar
 */
const ROLE_CAN_WRITE = {
  academico: false,
  administrativo: true,
};

/* =========================
   DOM refs (de tu index.html)
========================= */
const $btnLogin      = document.getElementById("btnLogin");
const $btnLogout     = document.getElementById("btnLogout");
const $userEmail     = document.getElementById("userEmail");
const $app           = document.getElementById("app");
const $unauthorized  = document.getElementById("unauthorized");

/* =========================
   UI helpers
========================= */
function show(el){ el?.classList.remove("hidden"); }
function hide(el){ el?.classList.add("hidden"); }

function setAuthedUI(email){
  if ($userEmail){
    $userEmail.textContent = email || "";
    email ? show($userEmail) : hide($userEmail);
  }

  hide($btnLogin);
  show($btnLogout);

  hide($unauthorized);
  show($app);
}

function setLoggedOutUI(){
  if ($userEmail){
    $userEmail.textContent = "";
    hide($userEmail);
  }

  show($btnLogin);
  hide($btnLogout);

  hide($app);
  hide($unauthorized);
}

function setUnauthorizedUI(email){
  if ($userEmail){
    $userEmail.textContent = email || "";
    show($userEmail);
  }

  show($btnLogin);
  hide($btnLogout);

  hide($app);
  show($unauthorized);
}

/* =========================
   Utils
========================= */
function normEmail_(email){
  return (email || "").toLowerCase().trim();
}

/** @returns {Role|null} */
function getRoleForEmail_(email){
  const e = normEmail_(email);
  if (!ALLOWED_EMAILS.has(e)) return null;
  return EMAIL_ROLE_MAP.get(e) || null;
}

function getAllowedCategories_(role){
  const cats = ROLE_CATEGORIES[role];
  return Array.isArray(cats) ? [...cats] : [];
}

function canWrite_(role){
  return !!ROLE_CAN_WRITE[role];
}

function emitAuthChanged_(detail){
  window.dispatchEvent(new CustomEvent("auth:changed", { detail }));
}

/* =========================
   Auth actions
========================= */
async function doLogin(){
  try {
    // Forzamos selección de cuenta para evitar "me dejó la cuenta anterior"
    googleProvider.setCustomParameters({ prompt: "select_account" });

    await signInWithPopup(auth, googleProvider);
    // onAuthStateChanged hace el resto
  } catch (err) {
    console.error("Login error:", err);

    const code = err?.code || "";
    const msg =
      code === "auth/popup-blocked" ? "El navegador bloqueó el popup. Permite popups y reintenta." :
      code === "auth/cancelled-popup-request" ? "Se canceló el inicio de sesión. Intenta de nuevo." :
      "No se pudo iniciar sesión. Revisa popups o vuelve a intentar.";

    alert(msg);
  }
}

async function doLogout(){
  try {
    await signOut(auth);
  } catch (err) {
    console.error("Logout error:", err);
    alert("No se pudo cerrar sesión. Intenta de nuevo.");
  }
}

/* =========================
   Events
========================= */
$btnLogin?.addEventListener("click", doLogin);
$btnLogout?.addEventListener("click", doLogout);

/* =========================
   Auth state listener
========================= */
onAuthStateChanged(auth, async (user) => {
  // Logged out
  if (!user) {
    setLoggedOutUI();
    emitAuthChanged_({
      user: null,
      allowed: false,
      email: "",
      role: null,
      canWrite: false,
      allowedCategories: [],
    });
    return;
  }

  const email = normEmail_(user.email);
  const role = getRoleForEmail_(email);
  const allowed = !!role;

  if (!allowed) {
    // Muestra mensaje y saca al usuario (más claro y evita confusiones)
    setUnauthorizedUI(email);

    emitAuthChanged_({
      user,
      allowed: false,
      email,
      role: null,
      canWrite: false,
      allowedCategories: [],
    });

    // Mini delay para que se alcance a ver el mensaje
    setTimeout(() => { signOut(auth).catch(()=>{}); }, 300);
    return;
  }

  const allowedCategories = getAllowedCategories_(role);
  const canWrite = canWrite_(role);

  setAuthedUI(email);

  emitAuthChanged_({
    user,
    allowed: true,
    email,
    role,
    canWrite,
    allowedCategories,
  });
});

/* =========================
   Exports (por si app.js lo quiere usar)
========================= */
export function isEmailAllowed(email){
  return ALLOWED_EMAILS.has(normEmail_(email));
}

export function getRoleForEmail(email){
  return getRoleForEmail_(email);
}

export function getPermissionsForEmail(email){
  const role = getRoleForEmail_(email);
  if (!role) {
    return { allowed: false, role: null, canWrite: false, allowedCategories: [] };
  }
  return {
    allowed: true,
    role,
    canWrite: canWrite_(role),
    allowedCategories: getAllowedCategories_(role),
  };
}