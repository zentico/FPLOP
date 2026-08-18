import fs from "node:fs";
import path from "node:path";

/** Walk up from cwd until we find the workspace root (contains solver/open-fpl-solver). */
function findWorkspaceRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "solver", "open-fpl-solver"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate workspace root containing solver/open-fpl-solver",
  );
}

export const WORKSPACE_ROOT = findWorkspaceRoot();
export const SOLVER_REPO = path.join(
  WORKSPACE_ROOT,
  "solver",
  "open-fpl-solver",
);
export const SOLVER_DATA_DIR = path.join(SOLVER_REPO, "data");
export const SOLVER_RESULTS_DIR = path.join(SOLVER_DATA_DIR, "results");
// FPLOP_STORE_DIR lets deployments (e.g. Docker) put the persistent store on
// a mounted volume; defaults to solver/store inside the workspace.
export const STORE_DIR =
  process.env["FPLOP_STORE_DIR"] || path.join(WORKSPACE_ROOT, "solver", "store");
export const RUNS_DIR = path.join(STORE_DIR, "runs");

for (const d of [STORE_DIR, RUNS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
