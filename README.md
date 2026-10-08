# obsidian-mcp

I keep my notes in an Obsidian vault, and my AI agents use the same vault as long-term memory. A vault is a folder of Markdown files, so all an agent needs is file access. This [MCP](https://modelcontextprotocol.io) server gives it that access from Claude Desktop, Claude Code or any other MCP client.

It works on the files directly. Obsidian can stay closed and there is no plugin to install. I run it in Docker with only the vault mounted, so it can't see the rest of my disk.

I built it with Claude Code.

## Tools

Paths are relative to the vault root. Parameters marked `?` are optional.

| Tool | Parameters | What it does |
| --- | --- | --- |
| `search` | `query`, `path?` | Case-insensitive text search. Returns up to 50 matching lines, each with the line before and after. |
| `read_note` | `path` | Returns the text of a file. Refuses images, PDFs and other common binary files, judged by file extension. |
| `list_files` | `path?`, `recursive?` | Lists a folder (the vault root by default). With `recursive: true` it lists every file below it. |
| `create_note` | `path`, `content` | Creates a file and any missing folders. Fails if the file already exists. |
| `append_note` | `path`, `content` | Adds a line break and the content to the end of an existing file. |
| `patch_note` | `path`, `find`, `replace` | Replaces the first exact match of `find` with `replace`. |
| `delete_note` | `path`, `confirm` | Deletes a file. `confirm` must be `true`. |
| `get_recent_changes` | `count?`, `path?` | Lists the most recently modified files, newest first. Returns 20 unless you set `count`. |

`search`, `list_files` and `get_recent_changes` skip `.obsidian`, `.git`, `.trash` and `node_modules`. No tool can read or write inside `.git` or `.obsidian`.

## Setup

You need Node 18 or later, or Docker. The server takes one setting, the path to your vault: pass it as the first argument or set `OBSIDIAN_VAULT_PATH`.

### Node

```sh
git clone https://github.com/nicappave/obsidian-mcp.git
cd obsidian-mcp
npm install
npm run build
node dist/index.js /path/to/your/vault
```

### Docker

```sh
docker build -t obsidian-mcp .
docker run -i --rm -v /path/to/your/vault:/vault obsidian-mcp
```

`-i` keeps stdin open, which the stdio transport needs. On Linux, add `--user` with your uid and gid (for example `--user 1000:1000`) so the notes it creates belong to you.

Either command starts the server on stdio. In daily use your MCP client runs it for you, set up as below.

### Claude Code

```sh
claude mcp add --scope user obsidian -- docker run -i --rm -v /path/to/your/vault:/vault obsidian-mcp
```

Without Docker:

```sh
claude mcp add --scope user obsidian -- node /path/to/obsidian-mcp/dist/index.js /path/to/your/vault
```

`--scope user` makes it available in every project.

### Claude Desktop and other MCP clients

Add the server to your client's MCP config. For Claude Desktop that is `claude_desktop_config.json`, found in `~/Library/Application Support/Claude/` on macOS and `%APPDATA%\Claude\` on Windows. Restart the app after saving.

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "/path/to/your/vault:/vault", "obsidian-mcp"]
    }
  }
}
```

Without Docker:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/path/to/obsidian-mcp/dist/index.js"],
      "env": { "OBSIDIAN_VAULT_PATH": "/path/to/your/vault" }
    }
  }
}
```

On Windows, write paths in JSON with forward slashes (`C:/Users/you/Vault`) or double backslashes.

## Safety

This server can change your vault. Before you connect an agent, put the vault under git or a backup so you can review and undo its edits.

- `delete_note` deletes the file permanently, skipping Obsidian's trash.
- `create_note` never overwrites an existing file. `patch_note` changes one match at a time.
- Paths that resolve outside the vault are refused. A symlink inside the vault can still lead outside it, so only link folders you are happy for an agent to read and edit.
- Every tool refuses paths inside `.git` and `.obsidian`. Git hooks and config, and Obsidian plugins, can run code on your machine, and plugin settings can hold API keys, so an agent can't touch them.
- The server talks over stdio and opens no network port.
- In Docker it can only see the folder you mount.
