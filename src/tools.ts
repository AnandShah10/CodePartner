/** Tool definitions for the agent loop. */

export const TOOLS = [
  {
    name: "run_command",
    description: "Run a shell command in the workspace root, hidden from the user (runs in a spawned background process, not a visible terminal). Use this for routine commands. For anything the user should watch or might want to type into — dev servers, watch/build processes, interactive CLIs — use run_in_terminal instead.",
    parameters: { type: "object", properties: { command: { type: "string", description: "The command to run." } }, required: ["command"] },
  },
  {
    name: "run_in_terminal",
    description: "Runs a command in a VISIBLE terminal panel the user can see and interact with, unlike run_command which runs hidden. Use this for dev servers, watch/build processes, interactive CLIs, or anything long-running or worth the user's attention. Set background=true for a command that doesn't exit on its own (e.g. a dev server) to start it and return immediately without waiting for it to finish. Output/exit-code capture depends on VS Code's shell integration being available for the user's shell — when it isn't, the command still runs visibly but output can't be captured automatically. For typing into an already-running interactive process without starting a new command line, use send_terminal_input.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        background: { type: "boolean", description: "If true, start the command and return immediately without waiting for it to finish (for servers/watchers that run indefinitely). Default false." },
      },
      required: ["command"],
    },
  },
  {
    name: "send_terminal_input",
    description: "Type text into the visible CodePartner terminal (interactive). Use for answering prompts (y/n), entering passwords when the user asked, or sending keys to a running process. Set press_enter=true (default) to submit a line; false to type without Enter.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to send to the terminal." },
        press_enter: { type: "boolean", description: "If true (default), append Enter after the text." },
      },
      required: ["text"],
    },
  },
  {
    name: "list_dir",
    description: "List contents of a directory.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Relative path to the directory." } }, required: ["path"] },
  },
  {
    name: "read_file",
    description: "Read the contents of a file.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Relative path to the file." } }, required: ["path"] },
  },
  {
    name: "edit_file",
    description: "Edit a file using search/replace. The search string must match exactly. Always read_file first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file." },
        search: { type: "string", description: "Exact text block to find (must match file content exactly, including whitespace)." },
        replace: { type: "string", description: "Replacement text block." },
      },
      required: ["path", "search", "replace"],
    },
  },
  {
    name: "create_file",
    description: "Create a new file or overwrite an existing file entirely.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file." },
        content: { type: "string", description: "Full content for the file." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "web_search",
    description: "Search the web for information using DuckDuckGo.",
    parameters: { type: "object", properties: { query: { type: "string", description: "The search query." } }, required: ["query"] },
  },
  {
    name: "call_subagent",
    description: "Dispatch a specialized SubAgent to independently work a sub-task using its own tools and message history, scoped to its type: researcher (web search, docs, read-only file/code search), code_expert (read, edit, create files, run commands), tester (run tests/commands, read files), writer (create files, read files, web search). Request multiple call_subagent calls in one turn to run them concurrently. These agents SHARE the real workspace — for concurrent agents editing the same files, use run_parallel_agents instead. If the repo defines its own custom agent personas (.codepartner/agents/*.md), use list_custom_agents / call_custom_agent instead of one of these fixed built-in types.",
    parameters: {
      type: "object",
      properties: {
        agent_type: { type: "string", enum: ["researcher", "code_expert", "tester", "writer"], description: "Type of specialized agent." },
        task: { type: "string", description: "Specific instruction for the sub-agent." },
        personality: { type: "string", description: "Optional persona trait (e.g. 'Strict Reviewer', 'Creative Prototyper') to modify behavior." },
      },
      required: ["agent_type", "task"],
    },
  },
  {
    name: "list_custom_agents",
    description: "Lists custom agent personas the repo has defined in .codepartner/agents/*.md (name, description, and which tools each one has). Check this before assuming only the four built-in agent types (researcher/code_expert/tester/writer) are available — a repo may define its own, more specific personas.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "call_custom_agent",
    description: "Runs a repo-defined custom agent persona (from .codepartner/agents/*.md) as a multi-turn, tool-using sub-agent — same underlying mechanism as call_subagent, but the persona/system prompt and tool access come from the repo's own file instead of a fixed built-in type. Use list_custom_agents first to see what's defined.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The custom agent's name, from list_custom_agents." },
        task: { type: "string", description: "Specific instruction for the agent." },
      },
      required: ["name", "task"],
    },
  },
  {
    name: "run_parallel_agents",
    description: "Runs 2-8 sub-agents concurrently, each FULLY ISOLATED in its own git branch and checked-out worktree — unlike call_subagent, these can safely edit the same files without conflicting with each other or the user's real working tree, since each operates on its own copy of the repo. Use this for trying several independent approaches to the same problem side by side (e.g. different implementations, different fixes) so the user can compare and pick one. Requires the workspace to be a git repository. Nothing is merged or applied automatically — each agent's branch is left in place with a diff summary for the user to review and merge manually.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              agent_type: { type: "string", enum: ["researcher", "code_expert", "tester", "writer"] },
              task: { type: "string", description: "Specific instruction for this agent — should be independent of the other agents' tasks." },
              personality: { type: "string" },
            },
            required: ["agent_type", "task"],
          },
          description: "2-8 independent tasks to run in parallel, each in its own isolated branch.",
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "create_artifact",
    description: "Record a code snippet, documentation, or result as an artifact for the user.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Description of the artifact." },
        content: { type: "string", description: "The actual code or text." },
        type: { type: "string", enum: ["code", "markdown", "log"], description: "Format of the artifact." },
      },
      required: ["title", "content", "type"],
    },
  },
  {
    name: "create_plan",
    description: "Create or replace the structured task checklist shown in the Plan panel, as a JSON array of task descriptions. Call once, after research, with the full ordered list of implementation steps. Use update_plan_task to mark steps done as you complete them.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Ordered list of concise, one-line task descriptions.",
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "update_plan_task",
    description: "Mark a task in the current plan done or not done, by its 0-based index.",
    parameters: {
      type: "object",
      properties: {
        index: { type: "number", description: "0-based index of the task in the plan." },
        done: { type: "boolean", description: "Whether the task is now complete." },
      },
      required: ["index", "done"],
    },
  },
  {
    name: "create_skill",
    description: "Save a reusable set of instructions or workflow as a skill.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the skill." },
        description: { type: "string", description: "What this skill does." },
        instructions: { type: "string", description: "The actual prompt or instructions for this skill." },
      },
      required: ["name", "description", "instructions"],
    },
  },
  {
    name: "use_skill",
    description: "Retrieve instructions from a previously saved skill by name. Note: skills whose description keyword-matches the user's current message are already auto-loaded into context at the start of the turn — check context before assuming you need this. Use this for a skill that didn't auto-trigger, or one you want by exact name.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the skill to use." },
      },
      required: ["name"],
    },
  },
  {
    name: "list_skills",
    description: "List all currently available skills (name + description) to see what exists, e.g. before deciding whether to create a new one or call use_skill on an existing one that didn't auto-trigger.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_control",
    description: "Computer-use browser (local Chrome via Puppeteer). Preferred loop: navigate → observe → click/type/select/scroll/press → observe/screenshot. Actions: navigate, observe, screenshot, click, type, hover, select, scroll, press, wait_for, evaluate, close.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["navigate", "observe", "screenshot", "click", "type", "hover", "select", "scroll", "press", "wait_for", "evaluate", "close"],
          description: "Browser action. Use observe after navigation and after interactions.",
        },
        url: { type: "string", description: "Target URL (navigate/screenshot/observe)." },
        selector: { type: "string", description: "CSS selector (click/type/hover/select/wait_for/press focus)." },
        text: { type: "string", description: "Text to type, or key name for press, or scroll direction." },
        value: { type: "string", description: "Option value/label for select." },
        direction: { type: "string", description: "Scroll direction: up|down|top|bottom." },
        key: { type: "string", description: "Key for press (Enter, Tab, Escape, ArrowDown, ...)." },
        script: { type: "string", description: "JavaScript expression for evaluate (use sparingly)." },
        limit: { type: "number", description: "Max interactive elements in observe (default 40)." },
      },
      required: ["action"],
    },
  },
  {
    name: "grep_search",
    description: "Search for a text pattern across files in the workspace. Returns matching lines with file paths and line numbers. Use this for finding function usages, variable references, or any text pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The text or regex pattern to search for." },
        path: { type: "string", description: "Relative path to search in (directory or file). Defaults to workspace root." },
        include: { type: "string", description: "File glob filter, e.g. '*.ts' or '*.py'. Defaults to all files." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "scan_licenses",
    description: "Scan workspace source files for SPDX identifiers and common license headers (MIT, Apache-2.0, GPL, BSD, etc.). Use before distributing code or when checking license consistency.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative directory or file to scan. Defaults to workspace root." },
        include_missing: { type: "boolean", description: "If true, also list files with no detectable license header." },
        max_files: { type: "number", description: "Maximum number of files to scan (default 80)." },
      },
    },
  },
  {
    name: "scan_code_references",
    description: "Copilot-style attribution check: find workspace regions similar to a code snippet (shingle similarity). Reports path, lines, score, and license when known. Use before treating generated or pasted code as original.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Code snippet to check for similar existing code." },
        path: { type: "string", description: "Optional subdirectory to limit the scan." },
        min_score: { type: "number", description: "Minimum similarity 0-1 (default 0.35)." },
        max_files: { type: "number", description: "Max files to scan (default 100)." },
      },
      required: ["code"],
    },
  },
  {
    name: "run_tests",
    description: "Run the project's test suite. Auto-detects the test runner (jest, vitest, mocha, pytest, etc.) or accepts a custom command. Use this to verify changes.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Custom test command. If omitted, auto-detects from package.json or project structure." },
      },
    },
  },
  {
    name: "index_docs",
    description: "Index a web documentation URL for later querying. Scrapes the page and saves it to local knowledge base.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL of the documentation to index." },
        title: { type: "string", description: "A friendly name for this documentation." },
      },
      required: ["url", "title"],
    },
  },
  {
    name: "query_knowledge",
    description: "Search across indexed documentation and knowledge. Uses keyword matching to find relevant excerpts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query or keyword." },
      },
      required: ["query"],
    },
  },
  {
    name: "generate_commit_message",
    description: "Generates a conventional commit message based on staged git changes.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_git_status",
    description: "Returns the current git status of the workspace.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "create_git_branch",
    description: "Creates a new git branch.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the new branch." },
      },
      required: ["name"],
    },
  },
  {
    name: "stage_git_changes",
    description: "Stages all current changes in the git repository.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "commit_git_changes",
    description: "Commits staged changes to the git repository. If the user's request implies opening a PR (or after committing to a feature branch), consider offering create_pull_request as the next step rather than stopping at the local commit.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The commit message." },
      },
      required: ["message"],
    },
  },
  {
    name: "create_pull_request",
    description: "Push the current branch (setting upstream if needed) and create a GitHub pull request for it against a base branch. Requires GitHub authentication (VS Code will prompt to sign in if needed) and a GitHub remote. Fails clearly if the current branch is the same as the base branch — create a feature branch first.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "PR title." },
        body: { type: "string", description: "PR description." },
        base: { type: "string", description: "Base branch (default: main)." },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "run_async_agent",
    description: "Start a LOCAL background agent job in the extension host (no cloud). Returns a job id immediately; work continues while the user keeps coding. Does not survive VS Code exit. Use list_async_agents to check status/results.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short label for the job." },
        prompt: { type: "string", description: "Task instructions for the background agent." },
        agent_type: {
          type: "string",
          description: "Built-in type: researcher | code_expert | tester | writer (default code_expert).",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_async_agents",
    description: "List local background agent jobs and their status/results.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "sync_plugin_catalog",
    description: "Clone or update the git-sourced plugin/agent catalog (codepartner.pluginCatalogRepo) into extension storage. Agents appear via list_custom_agents.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_ci_runs",
    description: "List recent GitHub Actions workflow runs via the gh CLI (no CodePartner backend). Requires gh auth.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max runs (default 10)." },
      },
    },
  },
  {
    name: "trigger_ci_workflow",
    description: "Trigger a GitHub Actions workflow with gh workflow run. Requires gh auth.",
    parameters: {
      type: "object",
      properties: {
        workflow: { type: "string", description: "Workflow file or name (e.g. ci.yml)." },
        ref: { type: "string", description: "Git ref (branch/tag). Optional." },
      },
      required: ["workflow"],
    },
  },
  {
    name: "write_ci_workflow",
    description: "Create or overwrite a GitHub Actions workflow file under .github/workflows/. Pass empty content for a sensible Node CI default.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Filename e.g. ci.yml (or full path under .github/workflows/)." },
        content: { type: "string", description: "YAML content. Optional default Node CI template if omitted." },
      },
      required: ["name"],
    },
  },

  {
    name: "re_run_last_tests",
    description: "Re-run the last test command used in this session (verification loop). Prefer this after fixing failures from run_tests.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];
