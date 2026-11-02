export type DashboardSceneMode = "auto" | "day" | "night";
export type DashboardScene = Exclude<DashboardSceneMode, "auto">;

export const DASHBOARD_SCENE_STORAGE_KEY = "dashboard-city-mode";
export const DASHBOARD_SCENE_EVENT = "dashboard-scene-change";

export function isDashboardSceneMode(value: string | null): value is DashboardSceneMode {
  return value === "auto" || value === "day" || value === "night";
}

export function resolveDashboardScene(mode: DashboardSceneMode, date: Date): DashboardScene {
  if (mode !== "auto") return mode;
  const hour = date.getHours();
  return hour >= 6 && hour < 20 ? "day" : "night";
}
