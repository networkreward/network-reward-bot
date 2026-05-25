import { pgTable, serial, text, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const userTasksTable = pgTable("user_tasks", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  taskId: integer("task_id").notNull(),
  rewardAmount: integer("reward_amount").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("user_task_unique").on(table.telegramId, table.taskId),
]);

export const insertUserTaskSchema = createInsertSchema(userTasksTable).omit({ id: true, completedAt: true });
export type InsertUserTask = z.infer<typeof insertUserTaskSchema>;
export type UserTask = typeof userTasksTable.$inferSelect;
