import { backendEndpoint } from "./backend";
import {
  listProjects,
  loadLatestProject,
  loadProject,
  parseProject,
  projectUpdatedAt,
  saveProject,
  setProjectUpdatedAt,
} from "./projects";
import type { Project } from "./projects";

type CloudProject = {
  name: string;
  state: Omit<Project, "name">;
  updated_at: string;
};

let uploadQueue: Promise<void> = Promise.resolve();

function stateOf(project: Project): Omit<Project, "name"> {
  const { name: _name, ...state } = project;
  return state;
}

async function cloudProjects(): Promise<CloudProject[]> {
  const response = await fetch(backendEndpoint("/api/projects"), {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Could not load cloud projects.");
  return response.json();
}

async function performUpload(
  storage: Storage,
  project: Project,
): Promise<void> {
  const response = await fetch(backendEndpoint("/api/projects"), {
    method: "PUT",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: project.name, state: stateOf(project) }),
  });
  if (!response.ok) throw new Error("Could not save the cloud project.");
  const saved: CloudProject = await response.json();
  setProjectUpdatedAt(storage, saved.name, saved.updated_at);
}

export function uploadProject(
  storage: Storage,
  project: Project,
): Promise<void> {
  const upload = uploadQueue.then(() => performUpload(storage, project));
  uploadQueue = upload.catch(() => {});
  return upload;
}

export async function syncProjects(storage: Storage): Promise<string[]> {
  const changedNames: string[] = [];
  let hadLatest = false;
  try {
    hadLatest = Boolean(loadLatestProject(storage));
  } catch {
    // A damaged latest-project pointer should not prevent cloud recovery.
  }
  const remote = await cloudProjects();
  const remoteByName = new Map(
    remote.map((project) => [project.name, project]),
  );
  const localByName = new Map(
    listProjects(storage).map((key) => {
      const project = loadProject(storage, key);
      return [project.name, project] as const;
    }),
  );

  for (const [name, local] of localByName) {
    const cloud = remoteByName.get(name);
    if (!cloud) {
      await uploadProject(storage, local);
      continue;
    }

    const localUpdatedAt = projectUpdatedAt(storage, name);
    const localTime = localUpdatedAt ? Date.parse(localUpdatedAt) : Number.NaN;
    const cloudTime = Date.parse(cloud.updated_at);
    if (Number.isFinite(localTime) && cloudTime > localTime) {
      const downloaded = parseProject(
        JSON.stringify({ ...cloud.state, name: cloud.name }),
      );
      saveProject(storage, downloaded, cloud.updated_at, false);
      changedNames.push(name);
    } else {
      await uploadProject(storage, local);
    }
    remoteByName.delete(name);
  }

  for (const cloud of remoteByName.values()) {
    const downloaded = parseProject(
      JSON.stringify({ ...cloud.state, name: cloud.name }),
    );
    saveProject(storage, downloaded, cloud.updated_at, false);
    changedNames.push(cloud.name);
  }

  if (!hadLatest) {
    const names = listProjects(storage)
      .map((key) => key.slice("proj/".length))
      .sort(
        (left, right) =>
          Date.parse(projectUpdatedAt(storage, right) ?? "") -
          Date.parse(projectUpdatedAt(storage, left) ?? ""),
      );
    const latestName = names[0];
    if (latestName) {
      const latest = loadProject(storage, `proj/${latestName}`);
      saveProject(
        storage,
        latest,
        projectUpdatedAt(storage, latestName) ?? new Date().toISOString(),
      );
    }
  }
  return changedNames;
}
