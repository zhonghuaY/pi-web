import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getProjectTrustStatus } from "../project-trust";

export type QueueModes = {
  steering: "all" | "one-at-a-time";
  followUp: "all" | "one-at-a-time";
};

export function readPiQueueModes(cwd: string): QueueModes {
  const agentDir = getAgentDir();
  let projectTrusted = false;
  try { projectTrusted = getProjectTrustStatus(cwd, agentDir).trusted; } catch { /* Do not load untrusted project settings. */ }
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  return {
    steering: settings.getSteeringMode() === "all" ? "all" : "one-at-a-time",
    followUp: settings.getFollowUpMode() === "all" ? "all" : "one-at-a-time",
  };
}
