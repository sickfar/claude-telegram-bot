#!/usr/bin/env bun
/**
 * Plan Mode MCP Server - Custom tools for plan-driven development.
 *
 * Provides 4 tools for creating, updating, and approving implementation plans:
 * - EnterPlanMode: Activate read-only planning mode
 * - WritePlan: Create a new plan file with metadata
 * - UpdatePlan: Update the active plan file
 * - ExitPlanMode: Request user approval for the plan
 *
 * Uses the official MCP TypeScript SDK.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "os";

const HOME = homedir();
const PLANS_DIR = `${HOME}/.claude/plans`;

// Word lists for random filename generation
const ADJECTIVES = [
  "polished",
  "humming",
  "bright",
  "swift",
  "clever",
  "gentle",
  "steady",
  "quiet",
  "bold",
  "calm",
  "keen",
  "wise",
  "quick",
  "light",
  "deep",
  "pure",
  "warm",
  "cool",
  "fresh",
  "clear",
];

const NOUNS = [
  "kettle",
  "falcon",
  "river",
  "mountain",
  "forest",
  "ocean",
  "meadow",
  "canyon",
  "glacier",
  "summit",
  "valley",
  "stream",
  "breeze",
  "thunder",
  "sunrise",
  "moonlight",
  "shadow",
  "crystal",
  "compass",
  "anchor",
];

const VERBS = [
  "dancing",
  "flowing",
  "soaring",
  "glowing",
  "spinning",
  "climbing",
  "drifting",
  "racing",
  "singing",
  "wandering",
  "blazing",
  "shining",
  "rippling",
  "echoing",
  "blooming",
  "rushing",
  "swaying",
  "gleaming",
  "sparkling",
  "tumbling",
];

// Generate random 3-word filename
function generatePlanFilename(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const verb = VERBS[Math.floor(Math.random() * VERBS.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${verb}-${noun}.md`;
}

// Read plan state file
async function getPlanState(sessionId: string): Promise<any> {
  const stateFile = `/tmp/plan-state-${sessionId}.json`;
  const file = Bun.file(stateFile);
  if (!(await file.exists())) {
    return null;
  }
  return JSON.parse(await file.text());
}

// Write plan state file
async function setPlanState(sessionId: string, state: any): Promise<void> {
  const stateFile = `/tmp/plan-state-${sessionId}.json`;
  await Bun.write(stateFile, JSON.stringify(state, null, 2));
}

// Ensure plans directory exists
async function ensurePlansDir(): Promise<void> {
  try {
    await Bun.write(`${PLANS_DIR}/.keep`, "");
  } catch (error) {
    throw new Error(`Failed to create plans directory: ${error}`);
  }
}

// Create the MCP server
const server = new Server(
  {
    name: "plan-mode",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "EnterPlanMode",
        description:
          "Activate plan mode. In plan mode, you can only use Read, Glob, Grep, Bash (read-only), WritePlan, and UpdatePlan tools. Use this to explore the codebase and create an implementation plan before coding.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      {
        name: "WritePlan",
        description:
          "Create a new implementation plan file. The plan is saved to ~/.claude/plans/ with a random 3-word filename. Plan content should be detailed markdown with sections like Overview, Architecture, Implementation Steps, etc.",
        inputSchema: {
          type: "object" as const,
          properties: {
            content: {
              type: "string",
              description:
                "The markdown content of the implementation plan. Should be detailed and structured.",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "UpdatePlan",
        description:
          "Update the active plan file with new content. Use this to refine your plan based on additional exploration or user feedback.",
        inputSchema: {
          type: "object" as const,
          properties: {
            content: {
              type: "string",
              description: "The updated markdown content for the plan.",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "ExitPlanMode",
        description:
          "Exit plan mode and present your plan for user approval. The user will see inline buttons to Accept, Reject, or Clear Context. IMPORTANT: Call this when your plan is complete and ready for review. After calling, STOP - do not add any text.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const sessionId = process.env.TELEGRAM_SESSION_ID || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";

  if (!sessionId) {
    throw new Error("TELEGRAM_SESSION_ID environment variable not set");
  }

  // EnterPlanMode
  if (request.params.name === "EnterPlanMode") {
    await ensurePlansDir();

    const state = {
      session_id: sessionId,
      plan_mode_enabled: true,
      active_plan_file: null,
      plan_created_at: new Date().toISOString(),
      restricted_tools: [
        "Read",
        "Glob",
        "Grep",
        "Bash",
        "WritePlan",
        "UpdatePlan",
        "ExitPlanMode",
      ],
    };

    await setPlanState(sessionId, state);

    return {
      content: [
        {
          type: "text" as const,
          text: "📋 Plan mode activated. You are now in READ-ONLY exploration mode.\n\nAvailable tools: Read, Glob, Grep, Bash (read-only), WritePlan, UpdatePlan, ExitPlanMode\n\nExplore the codebase and create a detailed implementation plan. When done, call ExitPlanMode to present your plan for approval.",
        },
      ],
    };
  }

  // WritePlan
  if (request.params.name === "WritePlan") {
    const args = request.params.arguments as { content?: string };
    const content = args.content;

    if (!content) {
      throw new Error("content parameter is required");
    }

    await ensurePlansDir();

    // Check if active plan already exists
    const state = await getPlanState(sessionId);
    if (state?.active_plan_file) {
      throw new Error(
        `Active plan already exists: ${state.active_plan_file}. Use UpdatePlan to modify it.`
      );
    }

    // Generate unique filename (try up to 10 times)
    let filename = "";
    let attempts = 0;
    while (attempts < 10) {
      filename = generatePlanFilename();
      const planPath = `${PLANS_DIR}/${filename}`;
      const file = Bun.file(planPath);
      if (!(await file.exists())) {
        break;
      }
      attempts++;
    }

    // Fallback to timestamp-based name if all attempts failed
    if (attempts === 10) {
      filename = `plan-${Date.now()}.md`;
    }

    // Create plan file with YAML frontmatter
    const frontmatter = `---
session_id: ${sessionId}
created_at: ${new Date().toISOString()}
status: draft
---

`;

    const planPath = `${PLANS_DIR}/${filename}`;
    await Bun.write(planPath, frontmatter + content);

    // Update state
    const newState = state || {
      session_id: sessionId,
      plan_mode_enabled: true,
      plan_created_at: new Date().toISOString(),
      restricted_tools: [
        "Read",
        "Glob",
        "Grep",
        "Bash",
        "WritePlan",
        "UpdatePlan",
        "ExitPlanMode",
      ],
    };
    newState.active_plan_file = filename;
    await setPlanState(sessionId, newState);

    return {
      content: [
        {
          type: "text" as const,
          text: `✅ Plan created: ${filename}\n\nLocation: ${planPath}\n\nYou can now:\n- Use UpdatePlan to refine the plan\n- Call ExitPlanMode when ready for user approval`,
        },
      ],
    };
  }

  // UpdatePlan
  if (request.params.name === "UpdatePlan") {
    const args = request.params.arguments as { content?: string };
    const content = args.content;

    if (!content) {
      throw new Error("content parameter is required");
    }

    const state = await getPlanState(sessionId);
    if (!state?.active_plan_file) {
      throw new Error(
        "No active plan file. Use WritePlan to create a plan first."
      );
    }

    const planPath = `${PLANS_DIR}/${state.active_plan_file}`;
    const file = Bun.file(planPath);

    if (!(await file.exists())) {
      // Plan file was manually deleted
      state.active_plan_file = null;
      await setPlanState(sessionId, state);
      throw new Error(
        "Plan file not found. It may have been deleted. Use WritePlan to create a new plan."
      );
    }

    // Read existing file to preserve frontmatter
    const existingContent = await file.text();
    const frontmatterMatch = existingContent.match(/^---\n([\s\S]*?)\n---\n/);

    let newContent: string;
    if (frontmatterMatch) {
      // Preserve existing frontmatter, update content
      const frontmatter = frontmatterMatch[0];
      newContent = frontmatter + content;
    } else {
      // No frontmatter found, add it
      const frontmatter = `---
session_id: ${sessionId}
created_at: ${new Date().toISOString()}
status: draft
---

`;
      newContent = frontmatter + content;
    }

    await Bun.write(planPath, newContent);

    return {
      content: [
        {
          type: "text" as const,
          text: `✅ Plan updated: ${state.active_plan_file}\n\nCall ExitPlanMode when ready for user approval.`,
        },
      ],
    };
  }

  // ExitPlanMode
  if (request.params.name === "ExitPlanMode") {
    const state = await getPlanState(sessionId);

    if (!state?.active_plan_file) {
      throw new Error(
        "No active plan file. Use WritePlan to create a plan before exiting plan mode."
      );
    }

    const planPath = `${PLANS_DIR}/${state.active_plan_file}`;
    const file = Bun.file(planPath);

    if (!(await file.exists())) {
      throw new Error(
        "Plan file not found. Use WritePlan to create a plan first."
      );
    }

    const planContent = await file.text();

    // Create approval request
    const requestId = crypto.randomUUID().slice(0, 8);
    const approvalData = {
      request_id: requestId,
      chat_id: chatId,
      plan_file: state.active_plan_file,
      plan_content: planContent,
      session_id: sessionId,
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const approvalFile = `/tmp/plan-${requestId}.json`;
    await Bun.write(approvalFile, JSON.stringify(approvalData, null, 2));

    // Update state to indicate approval is pending
    state.plan_approval_pending = true;
    await setPlanState(sessionId, state);

    return {
      content: [
        {
          type: "text" as const,
          text: "[Plan approval buttons sent to user. STOP HERE - do not output any more text. Wait for user to tap a button.]",
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Run the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Plan Mode MCP server running on stdio");
}

main().catch(console.error);
