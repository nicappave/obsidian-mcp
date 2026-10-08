import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Vault folder: first command-line argument, or the OBSIDIAN_VAULT_PATH environment variable.
const vaultSetting = process.argv[2] || process.env.OBSIDIAN_VAULT_PATH;
if (!vaultSetting) {
  console.error("No vault configured. Pass the vault folder as the first argument or set OBSIDIAN_VAULT_PATH.");
  process.exit(1);
}
const VAULT_ROOT = path.resolve(vaultSetting);
const vaultStat = await fs.stat(VAULT_ROOT).catch(() => null);
if (!vaultStat?.isDirectory()) {
  console.error(`Vault folder not found: ${VAULT_ROOT}`);
  process.exit(1);
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp", ".ico",
  ".pdf", ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".flac",
  ".zip", ".tar", ".gz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib",
  ".woff", ".woff2", ".ttf", ".eot",
]);

const EXCLUDED_DIRS = new Set([".obsidian", ".git", ".trash", "node_modules"]);

// Git hooks and config, and Obsidian plugins, can run code on the host, and plugin settings can hold API keys.
const PROTECTED_DIRS = new Set([".git", ".obsidian"]);

// --- Helpers ---

function resolveSafePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const resolved = path.resolve(VAULT_ROOT, normalized);
  // path.relative keeps this check correct on Windows (backslash separators, drive letters) as well as POSIX.
  const rel = path.relative(VAULT_ROOT, resolved);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error("Path is outside the vault. Access denied.");
  }
  if (rel.split(path.sep).some((part) => PROTECTED_DIRS.has(part.toLowerCase()))) {
    throw new Error("Path is inside .git or .obsidian. Access denied.");
  }
  return resolved;
}

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name);
}

function relativeToVault(absPath: string): string {
  return path.relative(VAULT_ROOT, absPath).replace(/\\/g, "/");
}

async function walkFiles(dir: string, recursive: boolean = true): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (isExcludedDir(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      results.push(...await walkFiles(full, true));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

// --- Server ---

const server = new McpServer({
  name: "obsidian-vault",
  version: "1.0.0",
});

// 1. search
server.tool(
  "search",
  "Search vault files by content. Returns matching lines with context.",
  {
    query: z.string().describe("Text to search for (case-insensitive)"),
    path: z.string().optional().describe("Subdirectory to search in (relative to vault root)"),
  },
  async ({ query, path: searchPath }) => {
    const dir = searchPath ? resolveSafePath(searchPath) : VAULT_ROOT;
    const files = await walkFiles(dir);
    const queryLower = query.toLowerCase();
    const matches: string[] = [];
    const MAX_RESULTS = 50;

    for (const file of files) {
      if (matches.length >= MAX_RESULTS) break;
      if (isBinary(file)) continue;

      try {
        const content = await fs.readFile(file, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_RESULTS) break;
          if (lines[i].toLowerCase().includes(queryLower)) {
            const rel = relativeToVault(file);
            const before = i > 0 ? `  ${i}: ${lines[i - 1]}` : "";
            const match = `> ${i + 1}: ${lines[i]}`;
            const after = i < lines.length - 1 ? `  ${i + 2}: ${lines[i + 1]}` : "";
            matches.push(`**${rel}**\n${[before, match, after].filter(Boolean).join("\n")}`);
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    if (matches.length === 0) {
      return { content: [{ type: "text", text: `No matches found for "${query}".` }] };
    }

    const header = matches.length >= MAX_RESULTS
      ? `Showing first ${MAX_RESULTS} matches (capped):\n\n`
      : `Found ${matches.length} match(es):\n\n`;

    return { content: [{ type: "text", text: header + matches.join("\n\n") }] };
  }
);

// 2. read_note
server.tool(
  "read_note",
  "Read the contents of a file in the vault.",
  {
    path: z.string().describe("File path relative to vault root"),
  },
  async ({ path: filePath }) => {
    const safe = resolveSafePath(filePath);
    if (isBinary(safe)) {
      return { content: [{ type: "text", text: `"${filePath}" is a binary file and cannot be read as text.` }], isError: true };
    }
    try {
      const content = await fs.readFile(safe, "utf-8");
      return { content: [{ type: "text", text: content }] };
    } catch {
      return { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true };
    }
  }
);

// 3. list_files
server.tool(
  "list_files",
  "List files in a vault directory.",
  {
    path: z.string().optional().describe("Directory path relative to vault root (defaults to root)"),
    recursive: z.boolean().optional().describe("List files recursively (default: false)"),
  },
  async ({ path: dirPath, recursive }) => {
    const dir = dirPath ? resolveSafePath(dirPath) : VAULT_ROOT;
    try {
      if (recursive) {
        const files = await walkFiles(dir, true);
        const relative = files.map(f => relativeToVault(f));
        return { content: [{ type: "text", text: `${relative.length} files:\n${relative.join("\n")}` }] };
      } else {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const lines = entries
          .filter(e => !isExcludedDir(e.name))
          .map(e => e.isDirectory() ? `${e.name}/` : e.name);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    } catch {
      return { content: [{ type: "text", text: `Directory not found: ${dirPath ?? "/"}` }], isError: true };
    }
  }
);

// 4. create_note
server.tool(
  "create_note",
  "Create a new file in the vault. Fails if the file already exists.",
  {
    path: z.string().describe("File path relative to vault root"),
    content: z.string().describe("File content"),
  },
  async ({ path: filePath, content }) => {
    const safe = resolveSafePath(filePath);
    await fs.mkdir(path.dirname(safe), { recursive: true });
    try {
      await fs.writeFile(safe, content, { flag: "wx" });
      return { content: [{ type: "text", text: `Created: ${filePath}` }] };
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        return { content: [{ type: "text", text: `File already exists: ${filePath}. Use append_note or patch_note instead.` }], isError: true };
      }
      return { content: [{ type: "text", text: `Error creating file: ${err?.message}` }], isError: true };
    }
  }
);

// 5. append_note
server.tool(
  "append_note",
  "Append content to an existing file in the vault.",
  {
    path: z.string().describe("File path relative to vault root"),
    content: z.string().describe("Content to append"),
  },
  async ({ path: filePath, content }) => {
    const safe = resolveSafePath(filePath);
    try {
      await fs.access(safe);
      await fs.appendFile(safe, "\n" + content);
      return { content: [{ type: "text", text: `Appended to: ${filePath}` }] };
    } catch {
      return { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true };
    }
  }
);

// 6. patch_note
server.tool(
  "patch_note",
  "Find and replace text in a vault file.",
  {
    path: z.string().describe("File path relative to vault root"),
    find: z.string().min(1).describe("Exact text to find"),
    replace: z.string().describe("Replacement text"),
  },
  async ({ path: filePath, find, replace }) => {
    const safe = resolveSafePath(filePath);
    try {
      const content = await fs.readFile(safe, "utf-8");
      if (!content.includes(find)) {
        return { content: [{ type: "text", text: `Search text not found in ${filePath}.` }], isError: true };
      }
      // Function form inserts the replacement literally, so "$$" math blocks and other "$" sequences survive.
      const updated = content.replace(find, () => replace);
      await fs.writeFile(safe, updated);
      return { content: [{ type: "text", text: `Patched: ${filePath}` }] };
    } catch {
      return { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true };
    }
  }
);

// 7. delete_note
server.tool(
  "delete_note",
  "Delete a file from the vault. Requires confirm: true.",
  {
    path: z.string().describe("File path relative to vault root"),
    confirm: z.literal(true).describe("Must be true to confirm deletion"),
  },
  async ({ path: filePath }) => {
    const safe = resolveSafePath(filePath);
    try {
      await fs.unlink(safe);
      return { content: [{ type: "text", text: `Deleted: ${filePath}` }] };
    } catch {
      return { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true };
    }
  }
);

// 8. get_recent_changes
server.tool(
  "get_recent_changes",
  "List the most recently modified files in the vault.",
  {
    count: z.number().int().min(1).optional().describe("Number of files to return (default: 20)"),
    path: z.string().optional().describe("Subdirectory to scope to (relative to vault root)"),
  },
  async ({ count, path: scopePath }) => {
    const dir = scopePath ? resolveSafePath(scopePath) : VAULT_ROOT;
    const limit = count ?? 20;
    const files = await walkFiles(dir);
    const stats: { rel: string; mtime: Date }[] = [];

    for (const file of files) {
      try {
        const stat = await fs.stat(file);
        stats.push({ rel: relativeToVault(file), mtime: stat.mtime });
      } catch {
        // skip
      }
    }

    stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const top = stats.slice(0, limit);
    const lines = top.map(s => `${s.mtime.toISOString().slice(0, 16).replace("T", " ")}  ${s.rel}`);
    return { content: [{ type: "text", text: `${top.length} most recent changes:\n${lines.join("\n")}` }] };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Obsidian MCP server running on stdio (vault: ${VAULT_ROOT})`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
