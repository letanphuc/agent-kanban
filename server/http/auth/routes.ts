import { beginOfflineSession, endOfflineSession, isOfflineMode, readOfflineSession } from "@server/auth/offline";
import { beginRealmrootLogin, endRealmrootWebSession, finishRealmrootLogin, readRealmrootWebSession } from "@server/auth/realmroot";
import type { Env } from "@server/env";
import type { Hono } from "hono";

export function registerAuthRoutes(api: Hono<{ Bindings: Env }>): void {
  api.get("/api/auth/login", (c) => (isOfflineMode(c) ? beginOfflineSession(c) : beginRealmrootLogin(c)));
  api.get("/api/auth/callback", finishRealmrootLogin);
  api.get("/api/auth/session", (c) => (isOfflineMode(c) ? readOfflineSession(c) : readRealmrootWebSession(c)));
  api.post("/api/auth/logout", (c) => (isOfflineMode(c) ? endOfflineSession(c) : endRealmrootWebSession(c)));
}
