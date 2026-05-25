import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";

export const broadcastsTable = pgTable("broadcasts", {
  id: serial("id").primaryKey(),
  type: text("type", { enum: ["text", "photo", "video"] }).notNull().default("text"),
  content: text("content").notNull(),
  mediaFileId: text("media_file_id"),
  status: text("status", { enum: ["scheduled", "sending", "completed", "failed", "cancelled"] }).notNull().default("scheduled"),
  targetFilter: text("target_filter", { enum: ["all", "active"] }).notNull().default("all"),
  totalTargets: integer("total_targets").notNull().default(0),
  sentCount: integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  blockedCount: integer("blocked_count").notNull().default(0),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Broadcast = typeof broadcastsTable.$inferSelect;
export type InsertBroadcast = typeof broadcastsTable.$inferInsert;
