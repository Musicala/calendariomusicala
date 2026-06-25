/* =============================================================================
  js/admin.js — Panel de administración (solo rol "direccion")
  -----------------------------------------------------------------------------
  Dos herramientas, sin tocar código:

   1) USUARIOS
      - Lista todos los usuarios registrados
      - Cambia el rol de cada uno con un menú
      - Activa / bloquea el acceso
      - Lista blanca por correo (emailRoles): pre-asigna el rol que tendrá
        alguien la primera vez que entre (aunque aún no haya iniciado sesión)

   2) PERMISOS (matriz)
      - Cuadrícula Roles × Categorías
      - Por cada celda: 👁 Ver  /  ✏ Editar
      - Se guarda en settings/access.permissions

  Todo se persiste en Firestore. Las reglas (firestore.rules) refuerzan que
  solo dirección pueda escribir aquí. El botón solo aparece para dirección.

  Este módulo construye su propio modal por JS para no tocar el HTML existente
  más allá de un botón en el header.
============================================================================= */

import {
  USER_ROLES,
  getCategories,
  normalizePermissionsMap
} from "./constants.js";

import {
  listUsers,
  updateUserRole,
  setUserActive,
  getAccessSettings,
  saveAccessSettings,
  listAuditLogs,
  getDeletedEvents,
  restoreEvent
} from "./db.js";

/* =========================
   Etiquetas legibles de rol
========================= */
const ROLE_LABELS = {
  [USER_ROLES.DIRECCION]:      "Dirección (admin total)",
  [USER_ROLES.ADMINISTRATIVO]: "Administrativo (admin)",
  [USER_ROLES.COMERCIAL]:      "Comercial",
  [USER_ROLES.DOCENTE]:        "Docente",
  [USER_ROLES.COMUNIDAD]:      "Estudiante / Acudiente"
};
const ROLE_ORDER = [
  USER_ROLES.DIRECCION,
  USER_ROLES.ADMINISTRATIVO,
  USER_ROLES.COMERCIAL,
  USER_ROLES.DOCENTE,
  USER_ROLES.COMUNIDAD
];

/* =========================
   Estado del panel
========================= */
let CURRENT_EMAIL = "";
let IS_ADMIN = false;
let elModal = null;     // contenedor del modal (creado una vez)
let WORKING = {         // copia editable cargada al abrir
  emailRoles: {},
  permissions: {}
};

/* =========================
   Helpers DOM
========================= */
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

function toast(msg) {
  const host = document.getElementById("toastHost");
  if (!host) { console.log(msg); return; }
  const t = h("div", { class: "toast", role: "status", text: msg });
  host.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/* =========================
   Botón en el header
========================= */
function ensureAdminButton() {
  let btn = document.getElementById("btnAdmin");
  if (!btn) {
    btn = h("button", {
      id: "btnAdmin",
      class: "btn ghost hidden",
      type: "button",
      title: "Administración",
      "aria-label": "Administración",
      onclick: openPanel
    }, "⚙ Admin");
    const headerRight = document.querySelector(".header-right");
    const logout = document.getElementById("btnLogout");
    if (headerRight) headerRight.insertBefore(btn, logout || null);
    else document.body.appendChild(btn);
  }
  btn.classList.toggle("hidden", !IS_ADMIN);
}

/* =========================
   Modal (se crea una sola vez)
========================= */
function ensureModal() {
  if (elModal) return elModal;

  const body = h("div", { class: "admin-body", id: "adminBody" });

  const tabsBar = h("div", { class: "admin-tabs", role: "tablist" }, [
    h("button", { class: "admin-tab active", type: "button", "data-tab": "users",
      onclick: () => switchTab("users") }, "Usuarios"),
    h("button", { class: "admin-tab", type: "button", "data-tab": "perms",
      onclick: () => switchTab("perms") }, "Permisos por rol"),
    h("button", { class: "admin-tab", type: "button", "data-tab": "audit",
      onclick: () => switchTab("audit") }, "Auditoría"),
    h("button", { class: "admin-tab", type: "button", "data-tab": "trash",
      onclick: () => switchTab("trash") }, "Papelera")
  ]);

  const head = h("div", { class: "admin-head" }, [
    h("div", {}, [
      h("h3", { text: "Administración" }),
      h("p", { class: "muted", text: "Gestiona usuarios, roles y qué ve cada quién." })
    ]),
    h("button", { class: "btn ghost", type: "button", "aria-label": "Cerrar",
      onclick: closePanel }, "✕")
  ]);

  const footer = h("div", { class: "admin-foot" }, [
    h("span", { class: "muted", id: "adminStatus", text: "" }),
    h("div", {}, [
      h("button", { class: "btn ghost", type: "button", onclick: closePanel }, "Cerrar"),
      h("button", { class: "btn primary", id: "btnAdminSave", type: "button",
        onclick: saveAll }, "Guardar cambios")
    ])
  ]);

  const content = h("div", { class: "admin-content", role: "document" }, [
    head, tabsBar, body, footer
  ]);

  const overlay = h("div", { class: "admin-overlay", onclick: closePanel });

  elModal = h("div", { class: "admin-modal hidden", role: "dialog", "aria-modal": "true",
    "aria-label": "Administración" }, [overlay, content]);
  document.body.appendChild(elModal);
  return elModal;
}

function switchTab(tab) {
  for (const t of elModal.querySelectorAll(".admin-tab")) {
    t.classList.toggle("active", t.getAttribute("data-tab") === tab);
  }
  // El botón "Guardar cambios" solo aplica a usuarios (lista blanca) y permisos.
  const saveBtn = document.getElementById("btnAdminSave");
  if (saveBtn) saveBtn.classList.toggle("hidden", tab === "audit" || tab === "trash");

  if (tab === "users") renderUsersTab();
  else if (tab === "audit") renderAuditTab();
  else if (tab === "trash") renderTrashTab();
  else renderPermsTab();
}

/* =========================
   Abrir / cerrar
========================= */
async function openPanel() {
  if (!IS_ADMIN) return;
  ensureModal();
  elModal.classList.remove("hidden");
  setStatus("Cargando…");
  try {
    const access = await getAccessSettings();
    WORKING.emailRoles  = { ...access.emailRoles };
    WORKING.permissions = normalizePermissionsMap(access.permissions);
    setStatus(access._source === "defaults"
      ? "Aún no hay configuración guardada (mostrando valores por defecto)."
      : "");
  } catch (e) {
    console.error(e);
    setStatus("No se pudo cargar la configuración.");
  }
  switchTab("users");
}

function closePanel() {
  if (elModal) elModal.classList.add("hidden");
}

function setStatus(msg) {
  const s = document.getElementById("adminStatus");
  if (s) s.textContent = msg || "";
}

/* =============================================================================
   TAB 1 — USUARIOS
============================================================================= */
async function renderUsersTab() {
  const body = document.getElementById("adminBody");
  body.innerHTML = "";
  body.appendChild(h("p", { class: "muted",
    text: "Cambia el rol o bloquea usuarios. Los cambios de usuario se guardan al instante." }));

  // ── Tabla de usuarios existentes ──
  const wrap = h("div", { class: "admin-table-wrap" });
  wrap.appendChild(h("p", { class: "muted", text: "Cargando usuarios…" }));
  body.appendChild(wrap);

  // ── Lista blanca por correo ──
  body.appendChild(buildEmailRolesSection());

  let users = [];
  try {
    users = await listUsers();
  } catch (e) {
    console.error(e);
    wrap.innerHTML = "";
    wrap.appendChild(h("p", { class: "muted",
      text: "No se pudieron cargar los usuarios (¿reglas desplegadas? ¿eres dirección?)." }));
    return;
  }

  wrap.innerHTML = "";
  const table = h("table", { class: "admin-table" });
  table.appendChild(h("thead", {}, h("tr", {}, [
    h("th", { text: "Correo" }),
    h("th", { text: "Nombre" }),
    h("th", { text: "Rol" }),
    h("th", { text: "Acceso" })
  ])));
  const tbody = h("tbody");

  for (const u of users) {
    const roleSel = h("select", { class: "admin-select",
      onchange: async (e) => {
        const newRole = e.target.value;
        try { await updateUserRole(u.uid, newRole, CURRENT_EMAIL); toast(`Rol de ${u.email} → ${ROLE_LABELS[newRole]}`); }
        catch (err) { console.error(err); toast("No se pudo cambiar el rol."); e.target.value = u.role; }
      }
    });
    for (const r of ROLE_ORDER) {
      const opt = h("option", { value: r, text: ROLE_LABELS[r] });
      if (r === u.role) opt.selected = true;
      roleSel.appendChild(opt);
    }

    const activeBtn = h("button", {
      class: "btn tiny " + (u.active ? "ghost" : "danger"),
      type: "button",
      onclick: async () => {
        try {
          await setUserActive(u.uid, !u.active, CURRENT_EMAIL);
          u.active = !u.active;
          activeBtn.textContent = u.active ? "Activo" : "Bloqueado";
          activeBtn.className = "btn tiny " + (u.active ? "ghost" : "danger");
          toast(`${u.email}: ${u.active ? "activo" : "bloqueado"}`);
        } catch (err) { console.error(err); toast("No se pudo cambiar el acceso."); }
      }
    }, u.active ? "Activo" : "Bloqueado");

    tbody.appendChild(h("tr", {}, [
      h("td", { text: u.email || "(sin correo)" }),
      h("td", { text: u.displayName || "—" }),
      h("td", {}, roleSel),
      h("td", {}, activeBtn)
    ]));
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  if (!users.length) wrap.appendChild(h("p", { class: "muted", text: "Aún no hay usuarios registrados." }));
}

function buildEmailRolesSection() {
  const sec = h("div", { class: "admin-subsection" });
  sec.appendChild(h("h4", { text: "Lista blanca por correo" }));
  sec.appendChild(h("p", { class: "muted",
    text: "Asigna el rol que tendrá un correo la primera vez que entre. Útil para dejar listos a admin, comercial o docentes antes de que inicien sesión. (Se guarda con «Guardar cambios».)" }));

  const list = h("div", { class: "admin-emailroles", id: "emailRolesList" });
  sec.appendChild(list);

  const newEmail = h("input", { type: "email", class: "admin-input",
    placeholder: "correo@ejemplo.com", id: "newEmailRole" });
  const newRole = h("select", { class: "admin-select", id: "newEmailRoleSel" });
  for (const r of ROLE_ORDER) newRole.appendChild(h("option", { value: r, text: ROLE_LABELS[r] }));
  const addBtn = h("button", { class: "btn tiny primary", type: "button",
    onclick: () => {
      const email = String(newEmail.value || "").trim().toLowerCase();
      if (!email || !email.includes("@")) { toast("Correo inválido."); return; }
      WORKING.emailRoles[email] = newRole.value;
      newEmail.value = "";
      renderEmailRolesList();
      toast("Agregado a la lista (recuerda Guardar).");
    }
  }, "Agregar");

  sec.appendChild(h("div", { class: "admin-emailroles-add" }, [newEmail, newRole, addBtn]));
  setTimeout(renderEmailRolesList, 0);
  return sec;
}

function renderEmailRolesList() {
  const list = document.getElementById("emailRolesList");
  if (!list) return;
  list.innerHTML = "";
  const entries = Object.entries(WORKING.emailRoles).sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) {
    list.appendChild(h("p", { class: "muted", text: "Sin correos en la lista." }));
    return;
  }
  for (const [email, role] of entries) {
    const sel = h("select", { class: "admin-select",
      onchange: (e) => { WORKING.emailRoles[email] = e.target.value; }
    });
    for (const r of ROLE_ORDER) {
      const opt = h("option", { value: r, text: ROLE_LABELS[r] });
      if (r === role) opt.selected = true;
      sel.appendChild(opt);
    }
    const del = h("button", { class: "btn tiny danger", type: "button",
      onclick: () => { delete WORKING.emailRoles[email]; renderEmailRolesList(); }
    }, "Quitar");
    list.appendChild(h("div", { class: "admin-emailrole-row" }, [
      h("span", { class: "admin-emailrole-email", text: email }), sel, del
    ]));
  }
}

/* =============================================================================
   TAB 2 — MATRIZ DE PERMISOS
============================================================================= */
function renderPermsTab() {
  const body = document.getElementById("adminBody");
  body.innerHTML = "";
  body.appendChild(h("p", { class: "muted",
    text: "👁 = puede VER la categoría · ✏ = puede CREAR/EDITAR. Marca lo que ve cada rol y pulsa «Guardar cambios»." }));

  const cats = getCategories(); // categorías reales activas
  const table = h("table", { class: "admin-matrix" });

  // Encabezado: roles
  const headRow = h("tr", {}, [ h("th", { class: "admin-matrix-corner", text: "Categoría \\ Rol" }) ]);
  for (const r of ROLE_ORDER) headRow.appendChild(h("th", { class: "admin-matrix-role", text: ROLE_LABELS[r] }));
  table.appendChild(h("thead", {}, headRow));

  const tbody = h("tbody");
  for (const cat of cats) {
    const row = h("tr", {}, [
      h("th", { class: "admin-matrix-cat" }, [
        h("span", { class: "cat-dot", style: `background:${cat.color}` }),
        h("span", { text: cat.label })
      ])
    ]);
    for (const r of ROLE_ORDER) {
      const perm = WORKING.permissions[r] || { read: [], write: [] };
      const canRead  = perm.read.includes(cat.id);
      const canWrite = perm.write.includes(cat.id);

      const readCb = h("input", { type: "checkbox", title: "Ver",
        onchange: (e) => togglePerm(r, cat.id, "read", e.target.checked, cell) });
      readCb.checked = canRead;
      const writeCb = h("input", { type: "checkbox", title: "Editar",
        onchange: (e) => togglePerm(r, cat.id, "write", e.target.checked, cell) });
      writeCb.checked = canWrite;
      writeCb.disabled = !canRead;

      const cell = h("td", { class: "admin-matrix-cell" }, [
        h("label", { class: "admin-cell-chk", title: "Ver" }, [readCb, document.createTextNode("👁")]),
        h("label", { class: "admin-cell-chk", title: "Editar" }, [writeCb, document.createTextNode("✏")])
      ]);
      cell._readCb = readCb; cell._writeCb = writeCb;
      row.appendChild(cell);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);

  body.appendChild(h("div", { class: "admin-table-wrap" }, table));
}

function togglePerm(role, catId, kind, checked, cell) {
  const perm = WORKING.permissions[role] || (WORKING.permissions[role] = { read: [], write: [] });
  const set = new Set(perm[kind]);
  if (checked) set.add(catId); else set.delete(catId);
  perm[kind] = Array.from(set);

  if (kind === "read" && !checked) {
    // si deja de ver, tampoco puede editar
    perm.write = perm.write.filter(id => id !== catId);
    if (cell?._writeCb) { cell._writeCb.checked = false; cell._writeCb.disabled = true; }
  }
  if (kind === "read" && checked && cell?._writeCb) {
    cell._writeCb.disabled = false;
  }
  if (kind === "write" && checked && !perm.read.includes(catId)) {
    // editar implica ver
    perm.read = Array.from(new Set([...perm.read, catId]));
    if (cell?._readCb) cell._readCb.checked = true;
  }
}

/* =============================================================================
   TAB 3 — AUDITORÍA
============================================================================= */
const ACTION_LABELS = {
  create:  { text: "Creó",      cls: "audit-create" },
  update:  { text: "Editó",     cls: "audit-update" },
  delete:  { text: "Eliminó",   cls: "audit-delete" },
  restore: { text: "Restauró",  cls: "audit-create" }
};

function formatAuditDate(ts) {
  try {
    const d = ts && typeof ts.toDate === "function" ? ts.toDate() : (ts ? new Date(ts) : null);
    if (!d || isNaN(d)) return "—";
    return d.toLocaleString("es-CO", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  } catch (_) { return "—"; }
}

async function renderAuditTab() {
  const body = document.getElementById("adminBody");
  body.innerHTML = "";
  body.appendChild(h("p", { class: "muted",
    text: "Registro de quién creó, editó o eliminó eventos. Solo lectura (no se puede modificar)." }));

  const wrap = h("div", { class: "admin-table-wrap" }, h("p", { class: "muted", text: "Cargando…" }));
  body.appendChild(wrap);

  let logs = [];
  try {
    logs = await listAuditLogs(150);
  } catch (e) {
    console.error(e);
    wrap.innerHTML = "";
    wrap.appendChild(h("p", { class: "muted",
      text: "No se pudo cargar la auditoría. ¿Publicaste las reglas nuevas? ¿Eres admin?" }));
    return;
  }

  if (!logs.length) {
    wrap.innerHTML = "";
    wrap.appendChild(h("p", { class: "muted",
      text: "Aún no hay registros. Aparecerán a medida que se creen/editen/eliminen eventos." }));
    return;
  }

  const table = h("table", { class: "admin-table" });
  table.appendChild(h("thead", {}, h("tr", {}, [
    h("th", { text: "Fecha" }),
    h("th", { text: "Quién" }),
    h("th", { text: "Acción" }),
    h("th", { text: "Evento" }),
    h("th", { text: "Categoría" })
  ])));
  const tbody = h("tbody");
  for (const log of logs) {
    const a = ACTION_LABELS[log.action] || { text: log.action || "—", cls: "" };
    tbody.appendChild(h("tr", {}, [
      h("td", { text: formatAuditDate(log.at) }),
      h("td", { text: log.by || "—" }),
      h("td", {}, h("span", { class: "audit-badge " + a.cls, text: a.text })),
      h("td", { text: log.title || "(sin título)" }),
      h("td", { text: log.category || "—" })
    ]));
  }
  table.appendChild(tbody);
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

/* =============================================================================
   TAB 4 — PAPELERA (restaurar eventos eliminados)
============================================================================= */
async function renderTrashTab() {
  const body = document.getElementById("adminBody");
  body.innerHTML = "";
  body.appendChild(h("p", { class: "muted",
    text: "Eventos eliminados. Puedes restaurarlos: vuelven al calendario tal como estaban." }));

  const wrap = h("div", { class: "admin-table-wrap" }, h("p", { class: "muted", text: "Cargando…" }));
  body.appendChild(wrap);

  let events = [];
  try {
    events = await getDeletedEvents(150);
  } catch (e) {
    console.error(e);
    wrap.innerHTML = "";
    wrap.appendChild(h("p", { class: "muted",
      text: "No se pudo cargar la papelera. ¿Publicaste las reglas? Puede que Firestore pida crear un índice (revisa la consola del navegador)." }));
    return;
  }

  if (!events.length) {
    wrap.innerHTML = "";
    wrap.appendChild(h("p", { class: "muted", text: "La papelera está vacía." }));
    return;
  }

  const table = h("table", { class: "admin-table" });
  table.appendChild(h("thead", {}, h("tr", {}, [
    h("th", { text: "Evento" }),
    h("th", { text: "Fecha" }),
    h("th", { text: "Categoría" }),
    h("th", { text: "" })
  ])));
  const tbody = h("tbody");

  for (const ev of events) {
    const restoreBtn = h("button", { class: "btn tiny primary", type: "button",
      onclick: async () => {
        restoreBtn.disabled = true;
        restoreBtn.textContent = "Restaurando…";
        try {
          await restoreEvent(ev.id, CURRENT_EMAIL);
          toast(`"${ev.title || "(sin título)"}" restaurado ✅`);
          row.remove();
          if (!tbody.querySelector("tr")) renderTrashTab();
        } catch (err) {
          console.error(err);
          toast("No se pudo restaurar.");
          restoreBtn.disabled = false;
          restoreBtn.textContent = "Restaurar";
        }
      }
    }, "Restaurar");

    const row = h("tr", {}, [
      h("td", { text: ev.title || "(sin título)" }),
      h("td", { text: ev.dateISO || "—" }),
      h("td", { text: ev.category || "—" }),
      h("td", {}, restoreBtn)
    ]);
    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

/* =============================================================================
   GUARDAR TODO (permisos + lista blanca)
============================================================================= */
async function saveAll() {
  const btn = document.getElementById("btnAdminSave");
  if (btn) btn.disabled = true;
  setStatus("Guardando…");
  try {
    await saveAccessSettings({
      emailRoles:  WORKING.emailRoles,
      permissions: WORKING.permissions
    }, CURRENT_EMAIL);
    setStatus("Guardado ✅  Los usuarios verán los cambios al recargar.");
    toast("Configuración guardada ✅");
  } catch (e) {
    console.error(e);
    setStatus("No se pudo guardar (¿reglas desplegadas? ¿eres dirección?).");
    toast("No se pudo guardar.");
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* =============================================================================
   Enganche con auth
============================================================================= */
window.addEventListener("auth:changed", (ev) => {
  const d = ev?.detail || {};
  CURRENT_EMAIL = (d.email || "").toLowerCase().trim();
  IS_ADMIN = d.allowed === true &&
    (d.role === USER_ROLES.DIRECCION || d.role === USER_ROLES.ADMINISTRATIVO);
  ensureAdminButton();
  if (!IS_ADMIN) closePanel();
});

// Por si el header ya existe al cargar el módulo
ensureAdminButton();
