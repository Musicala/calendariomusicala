/* =============================================================================
  js/auth.js — Autenticación con Firebase + roles desde Firestore
  -----------------------------------------------------------------------------
  FLUJO:
    1. Usuario hace clic en "Iniciar sesión"
    2. signInWithPopup (Google)
    3. onAuthStateChanged recibe el user de Firebase Auth
    4. Se busca su documento en Firestore: users/{uid}
    5a. Si existe → se usa su role y se verifica active
    5b. Si NO existe → se crea automáticamente con role "comunidad"
    6. Los permisos se derivan de ROLE_PERMISSIONS en constants.js
       (Firestore solo es fuente de verdad para "role" y "active")
    7. Se emite "auth:changed" para que app.js reaccione

  DETAIL del evento "auth:changed":
    {
      user:               Firebase User | null,
      allowed:            boolean,
      email:              string,
      displayName:        string,
      role:               string | null,
      canWrite:           boolean,
      allowedCategories:  string[]
    }

  REGLAS DE ACCESO:
    - active === false en Firestore → bloqueado (aunque tenga rol)
    - role no reconocido → se trata como "comunidad"
    - Si Firestore falla (offline, etc.) → se asigna "comunidad" con solo lectura
      (fail-safe: mejor dejar entrar con mínimos que dejar la app rota)
============================================================================= */

import { auth, googleProvider } from "./firebase.js";
import { getUserProfile, createUserProfile } from "./db.js";
import { USER_ROLES, getPermissionsForRole } from "./constants.js";

import {
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

/* =========================
   DOM refs
========================= */
const $btnLogin     = document.getElementById("btnLogin");
const $btnLogout    = document.getElementById("btnLogout");
const $userEmail    = document.getElementById("userEmail");
const $app          = document.getElementById("app");
const $unauthorized = document.getElementById("unauthorized");

/* =========================
   UI helpers
========================= */
function show(el) { el?.classList.remove("hidden"); }
function hide(el) { el?.classList.add("hidden"); }

function setAuthedUI(email) {
  if ($userEmail) {
    $userEmail.textContent = email || "";
    email ? show($userEmail) : hide($userEmail);
  }
  hide($btnLogin);
  show($btnLogout);
  hide($unauthorized);
  show($app);
}

function setLoggedOutUI() {
  if ($userEmail) {
    $userEmail.textContent = "";
    hide($userEmail);
  }
  show($btnLogin);
  hide($btnLogout);
  hide($app);
  hide($unauthorized);
}

function setUnauthorizedUI(email) {
  if ($userEmail) {
    $userEmail.textContent = email || "";
    show($userEmail);
  }
  show($btnLogin);
  hide($btnLogout);
  hide($app);
  show($unauthorized);
}

/* =========================
   Helpers internos
========================= */
function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Valida que el rol sea uno de los roles conocidos del sistema.
 * Si no lo reconoce, retorna "comunidad" (el más restrictivo).
 * @param {string} role
 * @returns {string}
 */
function sanitizeRole(role) {
  const knownRoles = Object.values(USER_ROLES);
  const normalized = String(role || "").trim().toLowerCase();
  return knownRoles.includes(normalized) ? normalized : USER_ROLES.COMUNIDAD;
}

function emitAuthChanged(detail) {
  window.dispatchEvent(new CustomEvent("auth:changed", { detail }));
}

/* =========================
   Auth actions
========================= */
async function doLogin() {
  try {
    googleProvider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, googleProvider);
    // onAuthStateChanged maneja el resto
  } catch (err) {
    console.error("[auth] Login error:", err);
    const code = err?.code || "";
    const msg =
      code === "auth/popup-blocked"
        ? "El navegador bloqueó el popup. Permite popups y reintenta."
        : code === "auth/cancelled-popup-request"
        ? "Se canceló el inicio de sesión. Intenta de nuevo."
        : "No se pudo iniciar sesión. Revisa popups o vuelve a intentar.";
    alert(msg);
  }
}

async function doLogout() {
  try {
    await signOut(auth);
  } catch (err) {
    console.error("[auth] Logout error:", err);
    alert("No se pudo cerrar sesión. Intenta de nuevo.");
  }
}

/* =========================
   Eventos de botones
========================= */
$btnLogin?.addEventListener("click",  doLogin);
$btnLogout?.addEventListener("click", doLogout);

/* =============================================================================
   AUTH STATE LISTENER
   ─────────────────────
   Punto central de toda la lógica de acceso.
   Se ejecuta:
   - Al cargar la página (si hay sesión guardada)
   - Al hacer login/logout
   - En CADA reload (Firebase reconecta la sesión automáticamente)
============================================================================= */
onAuthStateChanged(auth, async (user) => {

  /* ── Usuario no autenticado ── */
  if (!user) {
    setLoggedOutUI();
    emitAuthChanged({
      user:              null,
      allowed:           false,
      email:             "",
      displayName:       "",
      role:              null,
      canWrite:          false,
      allowedCategories: []
    });
    return;
  }

  /* ── Usuario autenticado ── */
  const email       = normEmail(user.email);
  const displayName = String(user.displayName || email || "").trim();

  let profile  = null;
  let role     = USER_ROLES.COMUNIDAD;
  let firestoreOk = true;

  /* ── Paso 1: buscar perfil en Firestore ── */
  try {
    profile = await getUserProfile(user.uid);
  } catch (err) {
    // Firestore offline u otro error → fail-safe con comunidad
    console.warn("[auth] No se pudo leer Firestore. Usando rol comunidad como fallback.", err);
    firestoreOk = false;
  }

  /* ── Paso 2: si no existe, crearlo automáticamente ── */
  if (firestoreOk && !profile) {
    try {
      profile = await createUserProfile({
        uid:         user.uid,
        email:       email,
        displayName: displayName
      });
      console.info("[auth] Perfil nuevo creado en Firestore con rol 'comunidad':", email);
    } catch (err) {
      console.warn("[auth] No se pudo crear perfil en Firestore. Usando comunidad.", err);
      firestoreOk = false;
    }
  }

  /* ── Paso 3: determinar rol ── */
  if (profile) {

    // Verificar si el usuario está bloqueado
    if (profile.active === false) {
      setUnauthorizedUI(email);
      emitAuthChanged({
        user,
        allowed:           false,
        email,
        displayName,
        role:              null,
        canWrite:          false,
        allowedCategories: []
      });
      // Cerrar sesión con delay para que el usuario vea el mensaje
      setTimeout(() => signOut(auth).catch(() => {}), 1500);
      return;
    }

    role = sanitizeRole(profile.role);
  }
  // Si firestoreOk === false (offline/error), role queda como "comunidad"

  /* ── Paso 4: derivar permisos desde ROLE_PERMISSIONS ── */
  // Los permisos NUNCA se leen de Firestore, siempre de constants.js.
  // Esto garantiza consistencia: cambiar permisos es solo tocar constants.js.
  const { canWrite, allowedCategories } = getPermissionsForRole(role);

  /* ── Paso 5: actualizar UI y emitir evento ── */
  setAuthedUI(email);

  emitAuthChanged({
    user,
    allowed:           true,
    email,
    displayName,
    role,
    canWrite,
    allowedCategories
  });

  // Log de debug (se puede quitar en producción)
  console.info(
    `[auth] ✅ ${email} | rol: ${role} | canWrite: ${canWrite}` +
    (firestoreOk ? "" : " | ⚠️ Firestore offline (fallback comunidad)")
  );
});

/* =============================================================================
   EXPORTS
   Útiles si otros módulos necesitan saber el rol actual sin escuchar el evento.
   Nota: estos son helpers de consulta puntual, no estado reactivo.
============================================================================= */

/**
 * Devuelve true si el email dado tiene un UID con perfil activo.
 * (Solo útil si ya tienes el perfil en memoria; para checks en tiempo real
 *  usa el evento "auth:changed".)
 * @deprecated Preferir escuchar "auth:changed" en su lugar.
 */
export function getPermissionsForEmail_LEGACY(email) {
  // Mantenido por compat si algo lo importaba. Retorna mínimos.
  console.warn("[auth] getPermissionsForEmail_LEGACY está obsoleto. Usa el evento auth:changed.");
  return {
    allowed:           false,
    role:              null,
    canWrite:          false,
    allowedCategories: []
  };
}

// Exportar USER_ROLES para conveniencia (evita importar constants en otros lados)
export { USER_ROLES };
