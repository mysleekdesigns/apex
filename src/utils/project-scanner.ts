import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import type { ProjectProfile } from '../types.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.apex-data', '.next', 'target', '__pycache__', '.venv']);

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function readDirStructure(dirPath: string, depth: number, maxDepth: number): Promise<string[]> {
  if (depth > maxDepth) return [];

  const entries: string[] = [];
  try {
    const items = await readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (SKIP_DIRS.has(item.name)) continue;

      const relativePath = depth === 0 ? item.name : item.name;
      const fullPath = path.join(dirPath, item.name);

      if (item.isDirectory()) {
        const prefix = '  '.repeat(depth);
        entries.push(`${prefix}${relativePath}/`);
        const children = await readDirStructure(fullPath, depth + 1, maxDepth);
        entries.push(...children.map((c) => `  `.repeat(depth) + c));
      } else {
        entries.push(`${'  '.repeat(depth)}${relativePath}`);
      }
    }
  } catch {
    // Directory not readable — skip
  }
  return entries;
}

export async function scanProject(projectPath: string): Promise<ProjectProfile> {
  const techStack: string[] = [];
  let depNames: string[] = [];
  let scripts: Record<string, string> = {};
  let projectType = 'unknown';
  let name = path.basename(projectPath);
  let description: string | undefined;

  // --- package.json (Node / JS / TS) ---
  const pkg = await readJsonFile<{
    name?: string;
    description?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  }>(path.join(projectPath, 'package.json'));

  if (pkg) {
    techStack.push('JavaScript');
    projectType = 'node';
    if (pkg.name) name = pkg.name;
    if (pkg.description) description = pkg.description;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    depNames = Object.keys(allDeps);
    scripts = pkg.scripts ?? {};

    // Detect common frameworks
    if (depNames.some((d) => d === 'react' || d === 'react-dom')) techStack.push('React');
    if (depNames.includes('next')) { techStack.push('Next.js'); projectType = 'web-app'; }
    if (depNames.includes('express')) techStack.push('Express');
    if (depNames.includes('vue')) techStack.push('Vue');
    if (depNames.includes('svelte')) techStack.push('Svelte');
    if (depNames.includes('@modelcontextprotocol/sdk')) techStack.push('MCP');
  }

  // --- tsconfig.json (TypeScript) ---
  if (await fileExists(path.join(projectPath, 'tsconfig.json'))) {
    // Replace JavaScript with TypeScript if present
    const jsIdx = techStack.indexOf('JavaScript');
    if (jsIdx !== -1) techStack[jsIdx] = 'TypeScript';
    else techStack.push('TypeScript');
  }

  // --- Cargo.toml (Rust) ---
  if (await fileExists(path.join(projectPath, 'Cargo.toml'))) {
    techStack.push('Rust');
    projectType = 'rust';
    const cargo = await readFile(path.join(projectPath, 'Cargo.toml'), 'utf-8').catch(() => '');
    const nameMatch = cargo.match(/^name\s*=\s*"(.+)"/m);
    if (nameMatch && !pkg) name = nameMatch[1];
  }

  // --- pyproject.toml / requirements.txt (Python) ---
  if (
    (await fileExists(path.join(projectPath, 'pyproject.toml'))) ||
    (await fileExists(path.join(projectPath, 'requirements.txt')))
  ) {
    techStack.push('Python');
    if (projectType === 'unknown') projectType = 'python';
  }

  // --- go.mod (Go) ---
  if (await fileExists(path.join(projectPath, 'go.mod'))) {
    techStack.push('Go');
    if (projectType === 'unknown') projectType = 'go';
  }

  // --- README for description ---
  if (!description) {
    try {
      const readme = await readFile(path.join(projectPath, 'README.md'), 'utf-8');
      description = readme.slice(0, 500).trim();
    } catch {
      // No README — fine
    }
  }

  // --- Directory structure (top 2 levels) ---
  const structure = await readDirStructure(projectPath, 0, 2);

  return {
    name,
    path: projectPath,
    type: projectType,
    techStack,
    dependencies: depNames,
    scripts,
    structure,
    description,
  };
}
