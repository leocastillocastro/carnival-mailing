import {
  createList,
  deleteList,
  getAllListsWithSubscriberCounts,
  getContactsForList,
  getListById,
  updateList,
} from "@carnival/db";
import type { FastifyInstance } from "fastify";
import { isForeignKeyViolation } from "../dbErrors.js";
import { parseIdParam } from "../params.js";
import { sendPage } from "../render.js";

const CONTACTS_PAGE_SIZE = 50;

interface ListForm {
  name?: string;
  description?: string;
}

// Every list is single opt-in — the schema still has a "double" value
// (packages/db's optinEnum) but nothing ever implemented what double
// opt-in should actually do (send a confirmation email, track a pending
// state...), so the form no longer offers a choice that changed nothing.
function parseListForm(body: ListForm) {
  const name = body.name?.trim();
  if (!name) throw new Error("El nombre es obligatorio");
  return {
    name,
    description: body.description?.trim() || null,
    optin: "single" as const,
  };
}

export async function listsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { flash?: string } }>("/lists", async (request, reply) => {
    const lists = await getAllListsWithSubscriberCounts();
    sendPage(request, reply, "lists/index", {
      title: "Listas",
      activeNav: "lists",
      flash: request.query.flash ?? null,
      lists,
    });
  });

  app.get("/lists/new", async (request, reply) => {
    sendPage(request, reply, "lists/form", { title: "Nueva lista", activeNav: "lists", list: null, error: null });
  });

  app.post<{ Body: ListForm }>("/lists", async (request, reply) => {
    try {
      const list = await createList(parseListForm(request.body));
      // Straight into continued editing, not back to the index — matches
      // campaigns' create flow, and the other two forms this same audit
      // flagged as inconsistent (segments, templates).
      reply.redirect(`/lists/${list.id}/edit?flash=${encodeURIComponent("Lista creada")}`);
    } catch (err) {
      sendPage(request, reply, "lists/form", {
        title: "Nueva lista",
        activeNav: "lists",
        list: request.body,
        error: (err as Error).message,
      });
    }
  });

  app.get<{ Params: { id: string } }>("/lists/:id/edit", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    const list = id === null ? null : await getListById(id);
    if (!list) {
      reply.code(404).send("Lista no encontrada");
      return;
    }
    sendPage(request, reply, "lists/form", { title: "Editar lista", activeNav: "lists", list, error: null });
  });

  app.post<{ Params: { id: string }; Body: ListForm }>("/lists/:id", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    if (id === null) {
      reply.code(404).send("Lista no encontrada");
      return;
    }
    try {
      await updateList(id, parseListForm(request.body));
      reply.redirect(`/lists?flash=${encodeURIComponent("Lista actualizada")}`);
    } catch (err) {
      sendPage(request, reply, "lists/form", {
        title: "Editar lista",
        activeNav: "lists",
        list: { id, ...request.body },
        error: (err as Error).message,
      });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { page?: string } }>("/lists/:id/contacts", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    const list = id === null ? null : await getListById(id);
    if (!list) {
      reply.code(404).send("Lista no encontrada");
      return;
    }
    const page = Math.max(1, Number(request.query.page) || 1);
    const { contacts, total } = await getContactsForList(id!, {
      limit: CONTACTS_PAGE_SIZE,
      offset: (page - 1) * CONTACTS_PAGE_SIZE,
    });
    sendPage(request, reply, "lists/contacts", {
      title: `Contactos de "${list.name}"`,
      activeNav: "lists",
      list,
      contacts,
      total,
      page,
      pageSize: CONTACTS_PAGE_SIZE,
    });
  });

  app.post<{ Params: { id: string } }>("/lists/:id/delete", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    if (id === null) {
      reply.code(404).send("Lista no encontrada");
      return;
    }
    try {
      await deleteList(id);
      reply.redirect(`/lists?flash=${encodeURIComponent("Lista eliminada")}`);
    } catch (err) {
      if (!isForeignKeyViolation(err)) throw err;
      const list = await getListById(id);
      sendPage(request, reply, "lists/form", {
        title: "Editar lista",
        activeNav: "lists",
        list,
        error: "No se puede borrar: todavía hay una o más campañas que usan esta lista.",
      });
    }
  });
}
