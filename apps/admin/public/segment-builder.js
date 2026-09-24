// Vanilla-JS island for editing a @carnival/segments RuleGroup tree.
// No build step: this file ships to the browser as-is.

const container = document.getElementById("segment-builder");
const hiddenInput = document.getElementById("segment-definition-input");
const form = document.getElementById("segment-form");
const countEl = document.getElementById("segment-count");
const lists = JSON.parse(document.getElementById("segment-lists-data").textContent);
// { city: ["Barcelona", "Madrid", ...], ... } — every contact.attributes key
// that's actually populated today, so its value can be a dropdown of the
// real values instead of free text the user has to get byte-for-byte right.
const attributeValues = JSON.parse(document.getElementById("segment-attribute-values-data").textContent);
let state = JSON.parse(document.getElementById("segment-definition-data").textContent);

// Add an entry here as soon as something new starts populating that
// contact.attributes key (see apps/admin/src/routes/segments.ts).
const KNOWN_ATTRIBUTES = [
  ["city", "Ciudad"],
  ["comunidadAutonoma", "Comunidad Autónoma"],
];

const OPS = [
  ["eq", "es igual a"],
  ["neq", "no es igual a"],
  ["gt", "mayor que"],
  ["gte", "mayor o igual que"],
  ["lt", "menor que"],
  ["lte", "menor o igual que"],
  ["contains", "contiene"],
  ["isEmpty", "está vacío"],
  ["isNotEmpty", "no está vacío"],
];
// contacts.status is a fixed Postgres enum, not free text — "contiene"/"mayor
// que"/etc. have no valid SQL operator against it (compile.ts's `like()`/
// `gt()` would reach Postgres as `operator does not exist: contact_status ~~
// text` the moment this segment is used). Only comparison-by-equality and
// presence checks make sense for an enum.
const STATUS_OPS = OPS.filter(([op]) => ["eq", "neq", "isEmpty", "isNotEmpty"].includes(op));
const VALUELESS_OPS = new Set(["isEmpty", "isNotEmpty"]);

const EVENT_TYPES = [
  ["open", "Apertura"],
  ["click", "Click"],
  ["bounce", "Rebote"],
  ["complaint", "Queja"],
  ["unsubscribe", "Baja"],
];

const LIST_STATUSES = [
  ["", "cualquier estado"],
  ["subscribed", "suscripto"],
  ["unsubscribed", "dado de baja"],
  ["pending", "pendiente"],
];

// contacts.status (packages/db/src/schema.ts) — a fixed enum, not free text,
// so offering it as a dropdown avoids someone typing "suscripto" and
// matching nothing because the real column stores "subscribed".
const CONTACT_STATUSES = [
  ["subscribed", "Suscripto"],
  ["unsubscribed", "Dado de baja"],
  ["bounced", "Rebotado"],
  ["complained", "Marcó como spam"],
];

const SHIPPING_METHODS = [
  ["", "cualquier método de envío"],
  ["home_delivery", "Envío a domicilio"],
  ["seur_frio", "Seur Frío"],
  ["local_pickup", "Recogida en tienda"],
];

const KIND_LABELS = {
  contact_field: "Campo de contacto",
  contact_attribute: "Atributo del contacto",
  list_membership: "Pertenece a lista",
  order_exists: "Compras",
  event_exists: "Eventos",
};

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children || []) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function selectEl(options, value, onChange) {
  const select = el("select", { onchange: (e) => onChange(e.target.value) }, []);
  for (const [val, label] of options) {
    const opt = el("option", { value: val }, [label]);
    if (val === value) opt.selected = true;
    select.appendChild(opt);
  }
  return select;
}

function textInput(value, onChange, placeholder) {
  return el("input", {
    type: "text",
    value: value ?? "",
    placeholder: placeholder || "",
    oninput: (e) => onChange(e.target.value),
  });
}

function numberInput(value, onChange, placeholder) {
  return el("input", {
    type: "number",
    value: value ?? "",
    placeholder: placeholder || "",
    oninput: (e) => onChange(e.target.value === "" ? undefined : Number(e.target.value)),
  });
}

function isGroup(node) {
  return node && typeof node === "object" && "glue" in node;
}

function defaultCondition(kind) {
  switch (kind) {
    case "contact_attribute":
      return { kind, path: KNOWN_ATTRIBUTES[0][0], op: "eq", value: "" };
    case "list_membership":
      return { kind, listId: lists.length > 0 ? lists[0].id : 0 };
    case "order_exists":
      return { kind, op: "any" };
    case "event_exists":
      return { kind, op: "any", type: "open" };
    case "contact_field":
    default:
      return { kind: "contact_field", field: "status", op: "eq", value: "subscribed" };
  }
}

function removeAt(path) {
  let parent = state;
  for (const i of path.slice(0, -1)) parent = parent.conditions[i];
  parent.conditions.splice(path[path.length - 1], 1);
  render();
}

function renderCondition(cond) {
  const box = el("div", { class: "rule-condition" }, [el("strong", {}, [KIND_LABELS[cond.kind] || cond.kind])]);
  const fields = el("div", { class: "rule-fields" }, []);

  if (cond.kind === "contact_field") {
    fields.appendChild(
      selectEl(
        [
          ["status", "Estado"],
          ["email", "Email"],
          ["createdAt", "Fecha de alta"],
        ],
        cond.field,
        (v) => {
          cond.field = v;
          // A value picked for the old field may not fit the new one (e.g. a
          // typed email left over after switching to "status").
          cond.value = v === "status" ? "subscribed" : "";
          // withinDays only means anything for "createdAt" (compile.ts treats
          // its mere presence as "use the rolling-window comparison instead
          // of op/value") — left over from a previous "createdAt" selection,
          // it silently overrides op/value against a column that was never
          // meant to be compared as a date, which Postgres rejects.
          if (v !== "createdAt") delete cond.withinDays;
          // A leftover op that doesn't apply to the new field (e.g. "contiene"
          // kept after switching to "status") would render invisibly — the
          // filtered dropdown below wouldn't show it as selected — while still
          // being what actually gets saved and sent to Postgres.
          cond.op = "eq";
          render();
        },
      ),
    );
    if (cond.field === "createdAt") {
      // A rolling window ("en los últimos N días") instead of op+value — a
      // fixed signup date would only ever match whoever was true on the day
      // the segment was saved, not stay "recientes" as time passes.
      if (cond.withinDays === undefined) cond.withinDays = 30;
      fields.appendChild(
        numberInput(
          cond.withinDays,
          (v) => {
            cond.withinDays = v;
          },
          "en los últimos N días",
        ),
      );
    } else {
      fields.appendChild(
        selectEl(cond.field === "status" ? STATUS_OPS : OPS, cond.op, (v) => {
          cond.op = v;
          render();
        }),
      );
      if (!VALUELESS_OPS.has(cond.op)) {
        fields.appendChild(
          cond.field === "status"
            ? selectEl(CONTACT_STATUSES, cond.value, (v) => {
                cond.value = v;
              })
            : textInput(cond.value, (v) => {
                cond.value = v;
              }),
        );
      }
    }
  } else if (cond.kind === "contact_attribute") {
    fields.appendChild(
      selectEl(KNOWN_ATTRIBUTES, cond.path, (v) => {
        cond.path = v;
        cond.value = ""; // a value picked for the old attribute may not exist for the new one
        render();
      }),
    );
    fields.appendChild(
      selectEl(OPS, cond.op, (v) => {
        cond.op = v;
        render();
      }),
    );
    if (!VALUELESS_OPS.has(cond.op)) {
      const knownValues = attributeValues[cond.path];
      fields.appendChild(
        knownValues
          ? selectEl(
              [["", "seleccioná una opción"], ...knownValues.map((v) => [v, v])],
              cond.value,
              (v) => {
                cond.value = v;
              },
            )
          : textInput(cond.value, (v) => {
              cond.value = v;
            }),
      );
    }
  } else if (cond.kind === "list_membership") {
    fields.appendChild(
      selectEl(
        lists.map((l) => [String(l.id), l.name]),
        String(cond.listId),
        (v) => {
          cond.listId = Number(v);
        },
      ),
    );
    fields.appendChild(
      selectEl(LIST_STATUSES, cond.status || "", (v) => {
        if (v) cond.status = v;
        else delete cond.status;
      }),
    );
  } else if (cond.kind === "order_exists") {
    fields.appendChild(
      selectEl(
        [
          ["any", "compró"],
          ["none", "no compró"],
        ],
        cond.op,
        (v) => {
          cond.op = v;
        },
      ),
    );
    fields.appendChild(
      numberInput(
        cond.withinDays,
        (v) => {
          if (v === undefined) delete cond.withinDays;
          else cond.withinDays = v;
        },
        "en los últimos N días",
      ),
    );
    fields.appendChild(
      textInput(
        cond.category,
        (v) => {
          if (v) cond.category = v;
          else delete cond.category;
        },
        "categoría (opcional)",
      ),
    );
    fields.appendChild(
      textInput(
        cond.sku,
        (v) => {
          if (v) cond.sku = v;
          else delete cond.sku;
        },
        "SKU (opcional)",
      ),
    );
    fields.appendChild(
      textInput(
        cond.status,
        (v) => {
          if (v) cond.status = v;
          else delete cond.status;
        },
        "estado del pedido (opcional)",
      ),
    );
    fields.appendChild(
      selectEl(SHIPPING_METHODS, cond.shippingMethod || "", (v) => {
        if (v) cond.shippingMethod = v;
        else delete cond.shippingMethod;
      }),
    );
  } else if (cond.kind === "event_exists") {
    fields.appendChild(
      selectEl(
        [
          ["any", "ocurrió"],
          ["none", "no ocurrió"],
        ],
        cond.op,
        (v) => {
          cond.op = v;
        },
      ),
    );
    fields.appendChild(
      selectEl(EVENT_TYPES, cond.type, (v) => {
        cond.type = v;
      }),
    );
    fields.appendChild(
      numberInput(
        cond.withinDays,
        (v) => {
          if (v === undefined) delete cond.withinDays;
          else cond.withinDays = v;
        },
        "en los últimos N días",
      ),
    );
  }

  box.appendChild(fields);
  return box;
}

function renderGroup(group, path) {
  const box = el("div", { class: "rule-group" }, []);
  box.appendChild(
    el("div", { class: "rule-group-header" }, [
      document.createTextNode("Combinar con: "),
      selectEl(
        [
          ["and", "Y (todas)"],
          ["or", "O (alguna)"],
        ],
        group.glue,
        (v) => {
          group.glue = v;
        },
      ),
    ]),
  );

  const list = el("div", { class: "rule-items" }, []);
  group.conditions.forEach((node, i) => {
    const itemPath = [...path, i];
    const row = isGroup(node) ? renderGroup(node, itemPath) : renderCondition(node);
    const removeBtn = el("button", { type: "button", class: "remove-btn", onclick: () => removeAt(itemPath) }, [
      "Quitar",
    ]);
    list.appendChild(el("div", { class: "rule-item" }, [row, removeBtn]));
  });
  box.appendChild(list);

  const kindSelect = selectEl(
    [
      ["contact_field", "Campo de contacto"],
      ["contact_attribute", "Atributo del contacto"],
      ["list_membership", "Pertenece a lista"],
      ["order_exists", "Compras"],
      ["event_exists", "Eventos (abrió/clickeó/...)"],
    ],
    "contact_field",
    () => {},
  );
  const addCondBtn = el(
    "button",
    {
      type: "button",
      class: "secondary",
      onclick: () => {
        group.conditions.push(defaultCondition(kindSelect.value));
        render();
      },
    },
    ["+ Condición"],
  );
  const addGroupBtn = el(
    "button",
    {
      type: "button",
      class: "secondary",
      onclick: () => {
        group.conditions.push({ glue: "and", conditions: [] });
        render();
      },
    },
    ["+ Grupo anidado"],
  );
  box.appendChild(el("div", { class: "rule-add" }, [kindSelect, addCondBtn, addGroupBtn]));

  return box;
}

let previewTimer = null;
let previewRequestId = 0;

// Debounced so a burst of edits (typing a value, clicking through several
// selects) doesn't fire one request per keystroke — only after things settle.
function schedulePreviewCount() {
  clearTimeout(previewTimer);
  countEl.textContent = "Calculando…";
  previewTimer = setTimeout(previewCount, 400);
}

async function previewCount() {
  const thisRequest = ++previewRequestId;
  try {
    const res = await fetch("/segments/preview-count", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "definition=" + encodeURIComponent(JSON.stringify(state)),
    });
    const data = await res.json();
    if (thisRequest !== previewRequestId) return;
    if (!res.ok) {
      countEl.textContent = data.error || "No se pudo calcular la cantidad de contactos.";
      return;
    }
    const count = typeof data.count === "number" ? data.count : "?";
    countEl.textContent = count + " contacto" + (count === 1 ? "" : "s") + " coincide" + (count === 1 ? "" : "n") + " ahora mismo.";
  } catch {
    if (thisRequest !== previewRequestId) return;
    countEl.textContent = "No se pudo calcular la cantidad de contactos.";
  }
}

function render() {
  container.innerHTML = "";
  container.appendChild(renderGroup(state, []));
  hiddenInput.value = JSON.stringify(state);
  schedulePreviewCount();
}

// Belt-and-suspenders: whatever render() missed (e.g. a value typed into a
// text/number field since the last structural change) is still captured here
// right before the browser actually submits the form.
form.addEventListener("submit", () => {
  hiddenInput.value = JSON.stringify(state);
});

render();
