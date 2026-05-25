import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const requiredChannelsTable = pgTable("required_channels", {
  id: serial("id").primaryKey(),
  channelId: text("channel_id").notNull().unique(),
  channelName: text("channel_name").notNull(),
  addedBy: text("added_by").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRequiredChannelSchema = createInsertSchema(requiredChannelsTable).omit({ id: true, createdAt: true });
export type InsertRequiredChannel = z.infer<typeof insertRequiredChannelSchema>;
export type RequiredChannel = typeof requiredChannelsTable.$inferSelect;
