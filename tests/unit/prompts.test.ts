// The fixed instructions carry the product's organizing rule. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT } from "../../src/sidepanel/services/llm/prompts.ts";

test("the AI is told to organize by what the user is working on, not by page type", () => {
  assert.match(SYSTEM_PROMPT, /Organize by what the user is working on/);
  assert.match(SYSTEM_PROMPT, /Never group by site type or format/);
  assert.match(SYSTEM_PROMPT, /\["Other", "Music"\]/);
});
