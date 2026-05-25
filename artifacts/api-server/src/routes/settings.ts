import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { botSettingsTable } from "@workspace/db";

const router = Router();

router.get("/", async (req, res) => {
  const settings = await db.select().from(botSettingsTable);
  res.json(settings);
});

router.get("/:key", async (req, res) => {
  const key = req.params["key"] ?? "";
  const [setting] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.key, key));
  if (!setting) { res.status(404).json({ error: "Paramètre introuvable" }); return; }
  res.json(setting);
});

router.put("/:key", async (req, res) => {
  const key = req.params["key"] ?? "";
  const { value } = req.body as { value?: unknown };
  if (typeof value !== "string") { res.status(400).json({ error: "Champ 'value' requis (string)" }); return; }
  const [updated] = await db
    .insert(botSettingsTable).values({ key, value, updatedBy: "api" })
    .onConflictDoUpdate({ target: botSettingsTable.key, set: { value, updatedBy: "api", updatedAt: new Date() } })
    .returning();
  res.json(updated);
});

router.delete("/:key", async (req, res) => {
  const key = req.params["key"] ?? "";
  const [existing] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.key, key));
  if (!existing) { res.status(404).json({ error: "Paramètre introuvable" }); return; }
  await db.delete(botSettingsTable).where(eq(botSettingsTable.key, key));
  res.status(204).end();
});

export default router;
