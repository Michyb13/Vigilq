import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Reads how many containers are currently running for a Compose service.
 * Shells out to `docker compose ps` rather than the raw Docker Engine API —
 * Compose (outside Swarm mode) manages plain containers, not a "service"
 * concept the Engine API understands the same way Swarm does, so asking
 * Compose itself is the simplest way to get an accurate replica count that
 * matches what `--scale` actually did.
 */
export async function getCurrentReplicaCount(composeFile: string, service: string): Promise<number> {
  const { stdout } = await execFileAsync("docker", [
    "compose",
    "-f",
    composeFile,
    "ps",
    "--format",
    "json",
    service,
  ]);

  const lines = stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);

  return lines.length;
}

/**
 * Scales a Compose service to an exact replica count. `--no-recreate`
 * avoids restarting containers that are already running and don't need to
 * change — only the delta (added or removed containers) is touched.
 */
export async function scaleService(composeFile: string, service: string, targetCount: number): Promise<void> {
  await execFileAsync("docker", [
    "compose",
    "-f",
    composeFile,
    "up",
    "-d",
    "--no-recreate",
    "--scale",
    `${service}=${targetCount}`,
    service,
  ]);
}
