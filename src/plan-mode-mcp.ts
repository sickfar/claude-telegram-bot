/**
 * In-process MCP server for plan mode tools.
 *
 * Replaces the external stdio-based server with a direct in-memory implementation.
 * Uses the session's planStateManager directly - no file I/O for state.
 */

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { PLANS_DIR, RESTRICTED_TOOLS } from "./plan-mode/constants";

// Word lists for random filename generation
const ADJECTIVES = [
  "polished", "humming", "bright", "swift", "clever", "gentle", "steady",
  "quiet", "bold", "calm", "keen", "wise", "quick", "light", "deep",
  "pure", "warm", "cool", "fresh", "clear",
];

const NOUNS = [
  "kettle", "falcon", "river", "mountain", "forest", "ocean", "meadow",
  "canyon", "glacier", "summit", "valley", "stream", "breeze", "thunder",
  "sunrise", "moonlight", "shadow", "crystal", "compass", "anchor",
];

const VERBS = [
  "dancing", "flowing", "soaring", "glowing", "spinning", "climbing",
  "drifting", "racing", "singing", "wandering", "blazing", "shining",
  "rippling", "echoing", "blooming", "rushing", "swaying", "gleaming",
  "sparkling", "tumbling",
];

// Generate random 3-word filename
function generatePlanFilename(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const verb = VERBS[Math.floor(Math.random() * VERBS.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${verb}-${noun}.md`;
}

// Ensure plans directory exists
async function ensurePlansDir(): Promise<void> {
  try {
    await Bun.write(`${PLANS_DIR}/.keep`, "");
  } catch (error) {
    throw new Error(`Failed to create plans directory: ${error}`);
  }
}

/**
 * Get session's plan state manager.
 * Lazy import to avoid circular dependencies.
 */
async function getPlanStateManager() {
  const { session } = await import("./session");
  return session.planStateManager;
}

/**
 * In-process MCP server for plan-driven development.
 */
export const planModeMcpServer = createSdkMcpServer({
  name: "plan-mode",
  version: "1.0.0",
  tools: [
    {
      name: "EnterPlanMode",
      description:
        "Activate plan mode. In plan mode, you can only use Read, Glob, Grep, Bash (read-only), WritePlan, and UpdatePlan tools. Use this to explore the codebase and create an implementation plan before coding.",
      inputSchema: {},
      handler: async () => {
        await ensurePlansDir();
        const manager = await getPlanStateManager();

        await manager.transition({ type: "ENTER_PLAN_MODE" });

        return {
          content: [
            {
              type: "text" as const,
              text: "📋 Plan mode activated. You are now in READ-ONLY exploration mode.\n\nAvailable tools: Read, Glob, Grep, Bash (read-only), WritePlan, UpdatePlan, ExitPlanMode\n\nExplore the codebase and create a detailed implementation plan. When done, call ExitPlanMode to present your plan for approval.",
            },
          ],
        };
      },
    },
    {
      name: "WritePlan",
      description:
        "Create a new implementation plan file. The plan is saved to ~/.claude/plans/ with a random 3-word filename. Plan content should be detailed markdown with sections like Overview, Architecture, Implementation Steps, etc.",
      inputSchema: {
        content: z
          .string()
          .describe(
            "The markdown content of the implementation plan. Should be detailed and structured."
          ),
      },
      handler: async (args) => {
        const { content } = args as { content: string };

        if (!content) {
          throw new Error("content parameter is required");
        }

        await ensurePlansDir();
        const manager = await getPlanStateManager();
        const state = manager.getState();
        const sessionId = manager.getSessionId() || "unknown";

        // Check if active plan already exists
        if (state.active_plan_file) {
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
        await manager.transition({ type: "WRITE_PLAN", planFile: filename });

        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Plan created: ${filename}\n\nLocation: ${planPath}\n\nYou can now:\n- Use UpdatePlan to refine the plan\n- Call ExitPlanMode when ready for user approval`,
            },
          ],
        };
      },
    },
    {
      name: "UpdatePlan",
      description:
        "Replace text in the active plan file. Use this to make targeted edits to your plan based on additional exploration or user feedback.",
      inputSchema: {
        old_string: z.string().describe("The text to replace"),
        new_string: z.string().describe("The text to replace it with"),
        replace_all: z
          .boolean()
          .optional()
          .default(false)
          .describe("Replace all occurrences of old_string (default: false)"),
      },
      handler: async (args) => {
        const { old_string, new_string, replace_all } = args as {
          old_string: string;
          new_string: string;
          replace_all?: boolean;
        };

        if (!old_string) {
          throw new Error("old_string parameter is required");
        }

        if (new_string === undefined || new_string === null) {
          throw new Error("new_string parameter is required");
        }

        if (old_string === new_string) {
          throw new Error(
            "old_string and new_string must be different"
          );
        }

        const manager = await getPlanStateManager();
        const state = manager.getState();
        const sessionId = manager.getSessionId() || "unknown";

        if (!state.active_plan_file) {
          throw new Error(
            "No active plan file. Use WritePlan to create a plan first."
          );
        }

        const planPath = `${PLANS_DIR}/${state.active_plan_file}`;
        const file = Bun.file(planPath);

        if (!(await file.exists())) {
          // Plan file was manually deleted - clear state
          await manager.transition({ type: "CLEAR_CONTEXT" });
          throw new Error(
            "Plan file not found. It may have been deleted. Use WritePlan to create a new plan."
          );
        }

        // Read existing file
        const existingContent = await file.text();
        const frontmatterMatch = existingContent.match(/^---\n([\s\S]*?)\n---\n/);

        // Extract plan body (without frontmatter)
        let planBody: string;
        let frontmatter: string;
        if (frontmatterMatch) {
          frontmatter = frontmatterMatch[0];
          planBody = existingContent.slice(frontmatter.length);
        } else {
          // No frontmatter found, create it
          frontmatter = `---
session_id: ${sessionId}
created_at: ${new Date().toISOString()}
status: draft
---

`;
          planBody = existingContent;
        }

        // Check if old_string exists in plan body
        if (!planBody.includes(old_string)) {
          throw new Error(
            `old_string not found in plan content: "${old_string.slice(0, 50)}${old_string.length > 50 ? "..." : ""}"`
          );
        }

        // Perform replacement
        const updatedBody = replace_all
          ? planBody.replaceAll(old_string, new_string)
          : planBody.replace(old_string, new_string);

        const newContent = frontmatter + updatedBody;
        await Bun.write(planPath, newContent);
        await manager.transition({ type: "UPDATE_PLAN", content: updatedBody });

        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Plan updated: ${state.active_plan_file}\n\nCall ExitPlanMode when ready for user approval.`,
            },
          ],
        };
      },
    },
    {
      name: "ExitPlanMode",
      description:
        "Exit plan mode and present your plan for user approval. The user will see inline buttons to Accept, Reject, or Clear Context. IMPORTANT: Call this when your plan is complete and ready for review. After calling, STOP - do not add any text.",
      inputSchema: {},
      handler: async () => {
        const manager = await getPlanStateManager();
        const state = manager.getState();

        // Validate that we have an active plan
        if (!state.active_plan_file) {
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

        // Mark approval as pending (session.ts handles the actual UI display)
        await manager.transition({ type: "REQUEST_APPROVAL", requestId: "" });

        // Return simple confirmation - session.ts displays the approval UI
        return {
          content: [
            {
              type: "text" as const,
              text: `[Plan approval requested for ${state.active_plan_file}. Waiting for user response.]`,
            },
          ],
        };
      },
    },
  ],
});
