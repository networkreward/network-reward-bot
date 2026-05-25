import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { broadcastsTable } from "@workspace/db";

const router = Router();

router.get("/", async (req, res) => {
  const broadcasts = await db.select().from(broadcastsTable).orderBy(desc(broadcastsTable.createdAt)).limit(50);
  res.json(broadcasts);
});

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }
  const [bc] = await db.select().from(broadcastsTable).where(eq(broadcastsTable.id, id));
  if (!bc) { res.status(404).json({ error: "Diffusion introuvable" }); return; }
  res.json(bc);
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }
  const [bc] = await db.select().from(broadcastsTable).where(eq(broadcastsTable.id, id));
  if (!bc) { res.status(404).json({ error: "Diffusion introuvable" }); return; }
  if (bc.status === "sending") { res.status(400).json({ error: "Impossible d'annuler une diffusion en cours" }); return; }
  await db.update(broadcastsTable).set({ status: "cancelled" }).where(eq(broadcastsTable.id, id));
  res.status(204).end();
});

export default router;
