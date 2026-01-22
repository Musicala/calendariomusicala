/* =============================================================================
  js/auth.js — Login/Logout + Allowlist + UI gating
  - Google Sign-In con popup
  - Solo permite ver/editar a correos específicos
  - Muestra/oculta #app y #unauthorized
  - Emite evento "auth:changed" para que app.js reaccione
============================================================================= */

import { auth, googleProvider } from "./firebase.js";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

/* =========================
   Allowlist (los únicos que entran)
========================= */
const ALLOWED_EMAILS = new Set([
  "musicalaasesor@gmail.com",
  "imusicala@gmail.com",
  "alekcaballeromusic@gmail.com",
  "catalina.medina.leal@gmail.com"
]);

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
  // Header
  if ($userEmail){
    $userEmail.textContent = email || "";
    email ? show($userEmail) : hide($userEmail);
  }
  // Botones
  hide($btnLogin);
  show($btnLogout);

  // App visible
  hide($unauthorized);
  show($app);
}

function setLoggedOutUI(){
  // Header
  if ($userEmail){
    $userEmail.textContent = "";
    hide($userEmail);
  }
  // Botones
  show($btnLogin);
  hide($btnLogout);

  // App escondida
  hide($app);
  hide($unauthorized);
}

function setUnauthorizedUI(email){
  // Header
  if ($userEmail){
    $userEmail.textContent = email || "";
    show($userEmail);
  }
  // Botones
  show($btnLogin);
  hide($btnLogout);

  // App NO visible
  hide($app);
  show($unauthorized);
}

/* =========================
   Auth actions
========================= */
async function doLogin(){
  try {
    googleProvider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, googleProvider);
    // onAuthStateChanged se encarga del resto
  } catch (err) {
    console.error("Login error:", err);
    alert("No se pudo iniciar sesión. Revisa popups o vuelve a intentar.");
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
  if (!user) {
    setLoggedOutUI();
    window.dispatchEvent(new CustomEvent("auth:changed", { detail: { user: null, allowed: false } }));
    return;
  }

  const email = (user.email || "").toLowerCase().trim();
  const allowed = ALLOWED_EMAILS.has(email);

  if (!allowed) {
    // Muestra mensaje y saca al usuario (más claro y evita confusiones)
    setUnauthorizedUI(email);
    window.dispatchEvent(new CustomEvent("auth:changed", { detail: { user, allowed: false } }));

    // Pequeño delay para que el usuario vea el mensaje si alcanza a parpadear UI
    // (sin dramas, solo UX)
    setTimeout(() => { signOut(auth).catch(()=>{}); }, 300);
    return;
  }

  setAuthedUI(email);
  window.dispatchEvent(new CustomEvent("auth:changed", { detail: { user, allowed: true } }));
});

/* =========================
   Exports (por si app.js lo quiere usar)
========================= */
export function isEmailAllowed(email){
  return ALLOWED_EMAILS.has((email || "").toLowerCase().trim());
}
