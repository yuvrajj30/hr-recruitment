import "server-only";
import { isUuid } from "@/lib/attendance/rules";
import { type AuthContext, requirePermission } from "@/lib/auth/context";
import type { Db } from "@/lib/db";
import { staffDb } from "@/lib/db-context";
import { notFound } from "@/lib/recruitment/errors";

// In-app notifications of the signed-in person. Row-level security shows each person only their own, and lets them
// change nothing but the read time (migrations 20261115140000_row_level_security, 20261116010000_security_hardening).
// Notifications are written by database functions (e.g. the task functions), never by the app account.

export type NotificationView = { id: string; type: string; subject: string; body: string; taskId: string | null; createdAt: Date; read: boolean };

export async function listMyNotifications(rawDb: Db, ctx: AuthContext, limit = 30): Promise<NotificationView[]> {
  requirePermission(ctx, "notification:read");
  const rows = await staffDb(rawDb, ctx).notification.findMany({
    where: { recipientUserId: ctx.user.id, channel: "IN_APP" },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    select: { id: true, type: true, subject: true, body: true, taskId: true, createdAt: true, readAt: true },
  });
  return rows.map((n) => ({ id: n.id, type: n.type, subject: n.subject, body: n.body, taskId: n.taskId, createdAt: n.createdAt, read: n.readAt !== null }));
}

export async function unreadCount(rawDb: Db, ctx: AuthContext): Promise<number> {
  requirePermission(ctx, "notification:read");
  return staffDb(rawDb, ctx).notification.count({ where: { recipientUserId: ctx.user.id, channel: "IN_APP", readAt: null } });
}

export async function markRead(rawDb: Db, ctx: AuthContext, notificationId: string): Promise<void> {
  requirePermission(ctx, "notification:read");
  if (!isUuid(notificationId)) throw notFound("That notification");
  const db = staffDb(rawDb, ctx);
  const r = await db.notification.updateMany({ where: { id: notificationId, recipientUserId: ctx.user.id, readAt: null }, data: { readAt: new Date() } });
  if (r.count === 0) {
    // Already read is fine; someone else's (invisible) is not found.
    const mine = await db.notification.findFirst({ where: { id: notificationId, recipientUserId: ctx.user.id }, select: { id: true } });
    if (!mine) throw notFound("That notification");
  }
}

export async function markAllRead(rawDb: Db, ctx: AuthContext): Promise<void> {
  requirePermission(ctx, "notification:read");
  await staffDb(rawDb, ctx).notification.updateMany({ where: { recipientUserId: ctx.user.id, readAt: null }, data: { readAt: new Date() } });
}
