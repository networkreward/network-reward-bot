import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { requiredChannelsTable } from "@workspace/db";
import {
  AdminAddChannelBody,
  AdminUpdateChannelBody,
} from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  const channels = await db.select().from(requiredChannelsTable).orderBy(requiredChannelsTable.id);
  res.json(channels);
});

router.post("/", async (req, res) => {
  const parsed = AdminAddChannelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Données invalides", details: parsed.error.issues });
    return;
  }
  const { channelId, channelName } = parsed.data;
  const existing = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.channelId, channelId));
  if (existing.length > 0) {
    res.status(400).json({ error: "Ce canal est déjà configuré" });
    return;
  }
  const [ch] = await db.insert(requiredChannelsTable).values({
    channelId,
    channelName,
    addedBy: "api",
    isActive: true,
  }).returning();
  res.status(201).json(ch);
});

router.patch("/:channelId", async (req, res) => {
  const id = parseInt(req.params["channelId"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }
  const parsed = AdminUpdateChannelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Données invalides", details: parsed.error.issues });
    return;
  }
  const [existing] = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Canal introuvable" }); return; }
  const [updated] = await db.update(requiredChannelsTable)
    .set({ isActive: parsed.data.isActive })
    .where(eq(requiredChannelsTable.id, id))
    .returning();
  res.json(updated);
});

router.delete("/:channelId", async (req, res) => {
  const id = parseInt(req.params["channelId"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }
  const [existing] = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Canal introuvable" }); return; }
  await db.delete(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
  res.status(204).end();
});

export default router;
