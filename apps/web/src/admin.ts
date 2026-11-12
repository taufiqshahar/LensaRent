import {
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_USAGE_LABELS,
} from "@lensarent/shared/leadOptions";
import type { LeadSource, LeadStatus, LeadUsage } from "@lensarent/shared/leadOptions";
import { formatMyMobile, whatsappUrl } from "@lensarent/shared/phone";
import { formatMytDate, formatMytDateTime } from "@lensarent/shared/time";
import type { ApiError } from "./dom";
import { NETWORK_ERROR, apiError, byId, el } from "./dom";

/**
 * Admin panel (Fasa 1): sign in, list leads, change status, keep notes, export CSV.
 * All data comes from /api/admin/*; the browser holds nothing but an HttpOnly cookie.
 */

interface Lead {
  id: string;
  name: string;
  phoneE164: string;
  desiredDate: string | null;
  usage: LeadUsage;
  source: LeadSource;
  status: LeadStatus;
  notes: string;
  createdAt: string;
}

interface Session {
  email: string;
}

const root = byId("admin-app", HTMLElement);
const brand = root?.dataset.brand ?? "LensaRent";

type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError; status: number };

async function api<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: init.body ? { "content-type": "application/json" } : {},
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR, status: 0 };
  }
  if (!response.ok) {
    return { ok: false, error: await apiError(response), status: response.status };
  }
  const value = (response.status === 204 ? null : await response.json()) as T;
  return { ok: true, value };
}

function render(...nodes: Node[]): void {
  root?.replaceChildren(...nodes);
}

// ── Sign in ─────────────────────────────────────────────────────────────────────────────

function showLogin(notice = ""): void {
  const status = el("p", { class: "form-status", role: "alert" }, notice);
  status.dataset.kind = notice ? "error" : "";
  const email = el("input", {
    id: "email",
    name: "email",
    type: "email",
    autocomplete: "username",
    required: true,
  });
  const password = el("input", {
    id: "password",
    name: "password",
    type: "password",
    autocomplete: "current-password",
    required: true,
  });
  const button = el("button", { class: "button button--block", type: "submit" }, "Log masuk");

  const form = el(
    "form",
    { class: "card admin-login" },
    el("h1", {}, `${brand} · Admin`),
    el("div", { class: "field" }, el("label", { for: "email" }, "Emel"), email),
    el("div", { class: "field" }, el("label", { for: "password" }, "Kata laluan"), password),
    button,
    status,
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    button.disabled = true;
    status.textContent = "";
    void api<Session>("/api/admin/session", {
      method: "POST",
      body: JSON.stringify({ email: email.value, password: password.value }),
    }).then((result) => {
      button.disabled = false;
      password.value = "";
      if (result.ok) {
        showLeads(result.value);
      } else {
        status.textContent = result.error.message;
        status.dataset.kind = "error";
      }
    });
  });

  render(form);
  email.focus();
}

// ── Leads ───────────────────────────────────────────────────────────────────────────────

function whatsappFor(lead: Lead): string {
  const when = lead.desiredDate ? ` pada ${formatMytDate(lead.desiredDate)}` : "";
  return whatsappUrl(
    lead.phoneE164,
    `Hai ${lead.name}, terima kasih kerana berminat menyewa DJI Osmo Pocket 4P dengan ${brand}. Saya ingin sahkan ketersediaan untuk tarikh anda${when}.`,
  );
}

function statusSelect(current: LeadStatus, id: string): HTMLSelectElement {
  return el(
    "select",
    { id, name: "status" },
    ...LEAD_STATUSES.map((status) =>
      el("option", { value: status, selected: status === current }, LEAD_STATUS_LABELS[status]),
    ),
  );
}

function leadCard(lead: Lead, onExpired: () => void): HTMLElement {
  const statusId = `status-${lead.id}`;
  const notesId = `notes-${lead.id}`;
  const select = statusSelect(lead.status, statusId);
  const notes = el("textarea", { id: notesId, name: "notes", rows: "2", maxlength: "2000" });
  notes.value = lead.notes;
  const saveNotes = el(
    "button",
    { class: "button button--small button--ghost", type: "button" },
    "Simpan nota",
  );
  const message = el("p", { class: "form-status small", role: "status" });

  const save = (body: Record<string, string>) => {
    message.textContent = "Menyimpan…";
    message.dataset.kind = "";
    void api(`/api/admin/leads/${lead.id}`, { method: "PUT", body: JSON.stringify(body) }).then(
      (result) => {
        if (!result.ok && result.status === 401) {
          onExpired();
          return;
        }
        message.textContent = result.ok ? "Disimpan." : result.error.message;
        message.dataset.kind = result.ok ? "ok" : "error";
      },
    );
  };
  select.addEventListener("change", () => {
    save({ status: select.value });
  });
  saveNotes.addEventListener("click", () => {
    save({ notes: notes.value });
  });

  return el(
    "li",
    { class: "card lead" },
    el(
      "div",
      { class: "lead__head" },
      el("h2", { class: "lead__name" }, lead.name),
      el(
        "time",
        { datetime: lead.createdAt, class: "muted small" },
        formatMytDateTime(new Date(lead.createdAt)),
      ),
    ),
    el(
      "dl",
      { class: "lead__facts" },
      el(
        "div",
        {},
        el("dt", {}, "Telefon"),
        el("dd", {}, el("a", { href: `tel:${lead.phoneE164}` }, formatMyMobile(lead.phoneE164))),
      ),
      el(
        "div",
        {},
        el("dt", {}, "Tarikh"),
        el("dd", {}, lead.desiredDate ? formatMytDate(lead.desiredDate) : "Belum pasti"),
      ),
      el("div", {}, el("dt", {}, "Kegunaan"), el("dd", {}, LEAD_USAGE_LABELS[lead.usage])),
      el("div", {}, el("dt", {}, "Sumber"), el("dd", {}, LEAD_SOURCE_LABELS[lead.source])),
    ),
    el(
      "div",
      { class: "lead__actions" },
      el(
        "a",
        {
          class: "button button--small",
          href: whatsappFor(lead),
          target: "_blank",
          rel: "noopener",
        },
        "WhatsApp",
      ),
      el("label", { for: statusId, class: "visually-hidden" }, "Status"),
      select,
    ),
    el("label", { for: notesId, class: "small" }, "Nota"),
    notes,
    saveNotes,
    message,
  );
}

function showLeads(session: Session): void {
  const list = el("ul", { class: "lead-list" });
  const more = el(
    "button",
    { class: "button button--ghost", type: "button", hidden: true },
    "Muat lagi",
  );
  const summary = el("p", { class: "muted small", role: "status" });

  const status = el(
    "select",
    { id: "filter-status", name: "status" },
    el("option", { value: "" }, "Semua status"),
    ...LEAD_STATUSES.map((value) => el("option", { value }, LEAD_STATUS_LABELS[value])),
  );
  const from = el("input", { id: "filter-from", name: "from", type: "date" });
  const to = el("input", { id: "filter-to", name: "to", type: "date" });
  const exportLink = el(
    "a",
    { class: "button button--small button--ghost", href: "/api/admin/leads/export" },
    "Eksport CSV",
  );

  const filters = () => {
    const params = new URLSearchParams();
    if (status.value) params.set("status", status.value);
    if (from.value) params.set("from", from.value);
    if (to.value) params.set("to", to.value);
    return params;
  };

  let nextBefore: string | null = null;
  let shown = 0;
  const expired = () => {
    showLogin("Sesi anda telah tamat. Sila log masuk semula.");
  };

  const load = (append: boolean) => {
    const params = filters();
    exportLink.href = `/api/admin/leads/export?${params.toString()}`;
    if (append && nextBefore) params.set("before", nextBefore);
    if (!append) {
      list.replaceChildren();
      shown = 0;
    }
    summary.textContent = "Memuatkan…";
    void api<{ leads: Lead[]; nextBefore: string | null }>(
      `/api/admin/leads?${params.toString()}`,
    ).then((result) => {
      if (!result.ok) {
        if (result.status === 401) {
          expired();
          return;
        }
        summary.textContent = result.error.message;
        return;
      }
      list.append(...result.value.leads.map((lead) => leadCard(lead, expired)));
      shown += result.value.leads.length;
      nextBefore = result.value.nextBefore;
      more.hidden = nextBefore === null;
      summary.textContent =
        shown === 0 ? "Tiada lead untuk penapis ini." : `${shown.toString()} lead dipaparkan.`;
    });
  };

  const filterForm = el(
    "form",
    { class: "filters card" },
    el("div", { class: "field" }, el("label", { for: "filter-status" }, "Status"), status),
    el("div", { class: "field" }, el("label", { for: "filter-from" }, "Dari"), from),
    el("div", { class: "field" }, el("label", { for: "filter-to" }, "Hingga"), to),
    el(
      "div",
      { class: "filters__actions" },
      el("button", { class: "button button--small", type: "submit" }, "Tapis"),
      exportLink,
    ),
  );
  filterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    load(false);
  });
  more.addEventListener("click", () => {
    load(true);
  });

  const logout = el(
    "button",
    { class: "button button--small button--ghost", type: "button" },
    "Log keluar",
  );
  logout.addEventListener("click", () => {
    void api("/api/admin/session", { method: "DELETE" }).then(() => {
      showLogin();
    });
  });

  render(
    el(
      "header",
      { class: "admin__bar" },
      el("strong", {}, `${brand} · Leads`),
      el("span", { class: "muted small" }, session.email),
      logout,
    ),
    el("div", { class: "admin__main" }, filterForm, summary, list, more),
  );
  load(false);
}

void api<Session>("/api/admin/session").then((result) => {
  if (result.ok) showLeads(result.value);
  else showLogin();
});
