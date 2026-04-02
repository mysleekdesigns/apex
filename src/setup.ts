import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { scanProject } from './utils/project-scanner.js';

const APEX_DATA_DIRS = ['episodes', 'memory', 'skills', 'reflections', 'metrics', 'snapshots'];
const GLOBAL_DIRS = ['skills', 'knowledge'];

interface ProjectIndex {
  projects: Array<{
    name: string;
    path: string;
    registeredAt: number;
  }>;
}

export async function setupProject(projectPath?: string): Promise<void> {
  const resolvedPath = projectPath ? path.resolve(projectPath) : process.cwd();
  const apexDataDir = path.join(resolvedPath, '.apex-data');
  const globalDir = path.join(homedir(), '.apex');

  // --- Create .apex-data/ directory structure ---
  for (const dir of APEX_DATA_DIRS) {
    await mkdir(path.join(apexDataDir, dir), { recursive: true });
  }

  // --- Create ~/.apex/ global directory ---
  for (const dir of GLOBAL_DIRS) {
    await mkdir(path.join(globalDir, dir), { recursive: true });
  }

  // Ensure global index files exist
  const projectsIndexPath = path.join(globalDir, 'projects-index.json');
  try {
    await readFile(projectsIndexPath, 'utf-8');
  } catch {
    await writeFile(projectsIndexPath, JSON.stringify({ projects: [] }, null, 2), 'utf-8');
  }

  const profilePath = path.join(globalDir, 'profile.json');
  try {
    await readFile(profilePath, 'utf-8');
  } catch {
    await writeFile(
      profilePath,
      JSON.stringify({ createdAt: Date.now(), preferences: {} }, null, 2),
      'utf-8',
    );
  }

  // --- Scan project ---
  const profile = await scanProject(resolvedPath);

  // --- Write project profile to .apex-data/config.json ---
  await writeFile(
    path.join(apexDataDir, 'config.json'),
    JSON.stringify(profile, null, 2),
    'utf-8',
  );

  // --- Register project in ~/.apex/projects-index.json ---
  let index: ProjectIndex;
  try {
    const raw = await readFile(projectsIndexPath, 'utf-8');
    index = JSON.parse(raw) as ProjectIndex;
  } catch {
    index = { projects: [] };
  }

  // Update existing entry or add new one
  const existing = index.projects.findIndex((p) => p.path === resolvedPath);
  const entry = { name: profile.name, path: resolvedPath, registeredAt: Date.now() };

  if (existing !== -1) {
    index.projects[existing] = entry;
  } else {
    index.projects.push(entry);
  }

  await writeFile(projectsIndexPath, JSON.stringify(index, null, 2), 'utf-8');
}
