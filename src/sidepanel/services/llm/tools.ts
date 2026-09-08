// Tool schemas the model must answer with (strict), and the sanitizers that
// turn untrusted tool input into typed values.
import type { Proposal } from "../../../types";
import type { FindMatch } from "./types";

export const PROPOSAL_TOOL = {
  name: "submit_proposal",
  description:
    "Submit the complete current folder/bookmark proposal for user review. Call with the FULL proposal (all folders and all tab assignments), never a diff. The UI renders it as a review tree; nothing is applied until the user approves.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      folders: {
        type: "array",
        description: "Every proposed folder with the tabs assigned to it.",
        items: {
          type: "object",
          properties: {
            path: {
              type: "array",
              items: { type: "string" },
              description:
                'Folder path from the root, one element per nesting level, e.g. ["Work", "Client A"].',
            },
            tabs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  url: { type: "string" },
                  title: { type: "string" },
                },
                required: ["url", "title"],
                additionalProperties: false,
              },
            },
            note: {
              type: "string",
              description:
                "One short line (max 12 words): what belongs in this folder, i.e. why these tabs are grouped here.",
            },
          },
          required: ["path", "tabs", "note"],
          additionalProperties: false,
        },
      },
      questions: {
        type: "array",
        description: "Questions about ambiguous tabs (empty array if none).",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            question: { type: "string" },
          },
          required: ["url", "question"],
          additionalProperties: false,
        },
      },
      removals: {
        type: "array",
        description:
          "Existing bookmarks to delete (cleanup passes only; empty array otherwise). Each needs a short reason.",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            reason: { type: "string" },
          },
          required: ["url", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["folders", "questions", "removals"],
    additionalProperties: false,
  },
};

export const FIND_TOOL = {
  name: "report_matches",
  description: "Report the library entries that best match the user's description, most likely first.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            why: { type: "string", description: "Why this matches, max 10 words." },
          },
          required: ["url", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["matches"],
    additionalProperties: false,
  },
};

export function sanitizeMatches(input: unknown): FindMatch[] {
  const raw = (input as { matches?: unknown })?.matches;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => typeof m?.url === "string" && m.url)
    .map((m) => ({ url: m.url as string, why: typeof m.why === "string" ? m.why.trim() : "" }))
    .slice(0, 10);
}


export function sanitizeProposal(input: unknown): Proposal {
  const raw = input as Partial<Proposal>;
  const folders = Array.isArray(raw.folders) ? raw.folders : [];
  const questions = Array.isArray(raw.questions) ? raw.questions : [];
  return {
    folders: folders
      .filter((f) => Array.isArray(f?.path) && f.path.length > 0 && f.path.every((p) => typeof p === "string" && p.trim()))
      .map((f) => ({
        path: f.path.map((p) => p.trim()),
        tabs: (Array.isArray(f.tabs) ? f.tabs : []).filter(
          (t) => typeof t?.url === "string" && t.url && typeof t?.title === "string"
        ),
        note: typeof f.note === "string" ? f.note.trim().slice(0, 120) : "",
      })),
    questions: questions.filter(
      (q) => typeof q?.question === "string" && q.question && typeof q?.url === "string"
    ),
    removals: (Array.isArray(raw.removals) ? raw.removals : []).filter(
      (r) => typeof r?.url === "string" && r.url && typeof r?.reason === "string"
    ),
  };
}

