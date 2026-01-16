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
        "Update the active plan file with new content. Use this to refine your plan based on additional exploration or user feedback.",
      inputSchema: {
        content: z
          .string()
          .describe("The updated markdown content for the plan."),
      },
      handler: async (args) => {
        const { content } = args as { content: string };

        if (!content) {
          throw new Error("content parameter is required");
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
        await manager.transition({ type: "UPDATE_PLAN", content });

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
