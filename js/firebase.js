/* =============================================================================
  js/firebase.js — Inicialización Firebase (Auth + Firestore)
  Compatible con GitHub Pages (ES Modules + CDN)
============================================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  serverTimestamp,
  Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* =========================
   Firebase Config (REAL)
========================= */
export const firebaseConfig = {
  apiKey: "AIzaSyASAoZ23sActUUK5N1JufPs_RlAN88eur0",
  authDomain: "calendario2026-ba6e5.firebaseapp.com",
  projectId: "calendario2026-ba6e5",
  storageBucket: "calendario2026-ba6e5.firebasestorage.app",
  messagingSenderId: "304545299996",
  appId: "1:304545299996:web:d0856ffe11b0420074e9d9"
};

/* =========================
   Init
========================= */
export const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);

/* =========================
   Google Provider
========================= */
export const googleProvider = new GoogleAuthProvider();
// googleProvider.setCustomParameters({ prompt: "select_account" });

/* =========================
   Time helpers
========================= */
export { serverTimestamp, Timestamp };
